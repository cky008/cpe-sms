import crypto from "node:crypto";

/**
 * Curve25519 prime 2^255 - 19 and Montgomery constant (486662 - 2) / 4 = 121665.
 *
 * IMPORTANT (Protocol specification for H168-383 `lib/elliptic.min.js` + `js/main.js`):
 * Huawei's WebUI uses `indutny/elliptic` `new elliptic.ec("curve25519")`, NOT standard
 * RFC 7748 X25519:
 *   1. Keys and coordinates are serialized in BIG-ENDIAN hex (NOT little-endian).
 *   2. Private scalars are NOT RFC 7748 clamped (`priv[0] &= 248`, etc.).
 *   3. `BN.toString("hex")` strips leading zero bytes if the top byte is `< 0x10`, so
 *      we generate ephemeral keys whose public and shared secrets are full 64-char hex.
 */
const CURVE25519_P = (1n << 255n) - 19n;
const CURVE25519_A24 = 121665n;

const GSM_7BIT_DEFAULT_TABLE = new Set([
  64, 163, 36, 165, 232, 233, 249, 236, 242, 199, 10, 216, 248, 13, 197, 229,
  916, 95, 934, 915, 923, 937, 928, 936, 931, 920, 926, 27, 198, 230, 223, 201,
  32, 33, 34, 35, 164, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
  51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 161, 65, 66, 67, 68, 69,
  70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88,
  89, 90, 196, 214, 209, 220, 167, 191, 97, 98, 99, 100, 101, 102, 103, 104,
  105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119,
  120, 121, 122, 228, 246, 241, 252, 224,
]);

const GSM_7BIT_EXT_TABLE = new Set([10, 94, 32, 123, 125, 92, 91, 126, 93, 124, 8364]);

export const SMS_TEXT_MODE_UCS2 = 0;
export const SMS_TEXT_MODE_7BIT = 1;

/**
 * Modulo over `2^255 - 19`.
 * @param {bigint} a
 * @returns {bigint}
 */
function modP(a) {
  const r = a % CURVE25519_P;
  return r >= 0n ? r : r + CURVE25519_P;
}

/**
 * Modular exponentiation `base^exp mod (2^255 - 19)`.
 * @param {bigint} base
 * @param {bigint} exp
 * @returns {bigint}
 */
function modPowP(base, exp) {
  let result = 1n;
  let b = modP(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % CURVE25519_P;
    b = (b * b) % CURVE25519_P;
    e >>= 1n;
  }
  return result;
}

/**
 * Unclamped Montgomery ladder scalar multiplication on Curve25519, matching
 * `indutny/elliptic` `ec("curve25519")`.
 *
 * @param {bigint} scalar
 * @param {bigint} uCoord
 * @returns {bigint}
 */
export function curve25519Mul(scalar, uCoord) {
  if (scalar <= 0n) return 0n;
  const x1 = modP(uCoord);
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;

  const bitLength = scalar.toString(2).length;
  for (let t = bitLength - 1; t >= 0; t--) {
    const kt = (scalar >> BigInt(t)) & 1n;
    swap ^= kt;
    if (swap) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = kt;

    const a = modP(x2 + z2);
    const aa = modP(a * a);
    const b = modP(x2 - z2);
    const bb = modP(b * b);
    const e = modP(aa - bb);
    const c = modP(x3 + z3);
    const d = modP(x3 - z3);
    const da = modP(d * a);
    const cb = modP(c * b);
    const sum = modP(da + cb);
    const diff = modP(da - cb);

    x3 = modP(sum * sum);
    z3 = modP(x1 * modP(diff * diff));
    x2 = modP(aa * bb);
    z2 = modP(e * modP(aa + modP(CURVE25519_A24 * e)));
  }

  if (swap) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }
  if (z2 === 0n) return 0n;
  return modP(x2 * modPowP(z2, CURVE25519_P - 2n));
}

/**
 * Generate an ephemeral Curve25519 client keypair and derive the 32-byte AES-256-GCM
 * shared key against the CPE's `ecc_server_pubkey`.
 *
 * @param {string} serverPubHex 64-char hex string from `authentication_login` or `/api/webserver/publickey`
 * @returns {{ clientPubHex: string, shareKeyHex: string, privateHex: string }}
 */
export function generateEccSession(serverPubHex) {
  if (!serverPubHex || !/^[0-9a-fA-F]{1,64}$/.test(serverPubHex)) {
    throw new Error("Invalid CPE ECC server public key");
  }
  const serverU = BigInt(`0x${serverPubHex}`);
  if (serverU <= 1n) {
    throw new Error("Rejected weak CPE ECC server public key");
  }

  for (let attempt = 0; attempt < 64; attempt++) {
    const privBytes = crypto.randomBytes(32);
    // Keep scalar below curve order (~2^252) while ensuring high entropy
    privBytes[0] &= 0x0f;
    privBytes[0] |= 0x08;
    const priv = BigInt(`0x${privBytes.toString("hex")}`);
    const clientPub = curve25519Mul(priv, 9n);
    const shared = curve25519Mul(priv, serverU);
    const clientPubHex = clientPub.toString(16);
    const shareKeyHex = shared.toString(16);

    // Ensure full 64-hex length (top nibble != 0) so `BN.toString("hex")` in firmware
    // and `Buffer.from(hex, "hex")` always agree on exact 32-byte AES-256 key length.
    if (clientPubHex.length === 64 && shareKeyHex.length === 64) {
      return {
        clientPubHex,
        shareKeyHex,
        privateHex: priv.toString(16),
      };
    }
  }
  throw new Error("Failed to generate 64-hex Curve25519 session key");
}

/**
 * Compute Huawei's non-standard SCRAM-SHA256 client proof and expected server signature.
 *
 * Note: Unlike RFC 5802, Huawei's firmware (`main.js` module 19) passes `"Client Key"`,
 * `"Server Key"`, and `authMessage` as the HMAC *key*, and the derived hashes as the HMAC *data*.
 *
 * @param {string} password
 * @param {string} saltHex
 * @param {number} iterations
 * @param {string} firstNonce
 * @param {string} serverNonce
 */
export function computeScram(password, saltHex, iterations, firstNonce, serverNonce) {
  // Forge's `forge.pbkdf2(password, ...)` treats JS strings as raw byte charCodes (`latin1`)
  const pwdBytes = Buffer.from(password, "latin1");
  const saltBytes = Buffer.from(saltHex, "hex");
  const saltedPwd = crypto.pbkdf2Sync(pwdBytes, saltBytes, Number(iterations), 32, "sha256");

  const clientKey = crypto
    .createHmac("sha256", Buffer.from("Client Key", "utf8"))
    .update(saltedPwd)
    .digest();
  const serverKey = crypto
    .createHmac("sha256", Buffer.from("Server Key", "utf8"))
    .update(saltedPwd)
    .digest();
  const storedKey = crypto.createHash("sha256").update(clientKey).digest();

  const authMessage = Buffer.from(`${firstNonce},${serverNonce},${serverNonce}`, "utf8");
  const clientSignature = crypto.createHmac("sha256", authMessage).update(storedKey).digest();

  const clientProof = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    clientProof[i] = clientKey[i] ^ clientSignature[i];
  }

  const expectedServerSig = crypto
    .createHmac("sha256", authMessage)
    .update(serverKey)
    .digest("hex");

  return {
    clientProofHex: clientProof.toString("hex"),
    expectedServerSig,
    serverKey,
  };
}

/**
 * Verify `ecc_pubkey_signature` returned by `authentication_login` against `ServerKey`
 * to prevent MITM substitution of the ECDH public key.
 *
 * @param {string} pubkeyHex
 * @param {Buffer} serverKeyBytes
 * @param {string} expectedSignatureHex
 * @returns {boolean}
 */
export function verifyPubkeySignature(pubkeyHex, serverKeyBytes, expectedSignatureHex) {
  if (!pubkeyHex || !expectedSignatureHex) return false;
  const computed = crypto
    .createHmac("sha256", serverKeyBytes)
    .update(Buffer.from(pubkeyHex, "hex"))
    .digest("hex");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(expectedSignatureHex.toLowerCase(), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Encrypt UTF-8 XML payload using H168-383 AES-256-GCM wire format:
 * `[8-hex uint32_le(utf8_byte_len)] + [24-hex 12B IV] + [32-hex 16B GCM Tag] + [Ciphertext Hex]`
 * with `AAD = 16 zero bytes`.
 *
 * @param {string} plainText
 * @param {string} shareKeyHex 64-char hex key
 * @param {Buffer} [ivBytes] optional 12-byte IV (for deterministic unit testing)
 * @returns {string}
 */
export function aesGcmEncrypt(plainText, shareKeyHex, ivBytes = crypto.randomBytes(12)) {
  if (!plainText) return "";
  const key = Buffer.from(shareKeyHex, "hex");
  const utf8 = Buffer.from(plainText, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(utf8.length, 0);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, ivBytes);
  cipher.setAAD(Buffer.alloc(16, 0));
  const encrypted = Buffer.concat([cipher.update(utf8), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return (
    lenBuf.toString("hex") +
    ivBytes.toString("hex") +
    authTag.toString("hex") +
    encrypted.toString("hex")
  );
}

/**
 * Decrypt H168-383 AES-256-GCM hex payload back into UTF-8 XML starting at `<response>`.
 *
 * @param {string} hexPayload
 * @param {string} shareKeyHex 64-char hex key
 * @returns {string}
 */
export function aesGcmDecrypt(hexPayload, shareKeyHex) {
  const cleanHex = (hexPayload || "").trim();
  if (cleanHex.length < 64 || cleanHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleanHex)) {
    throw new Error(`Invalid AES-GCM hex payload (len=${cleanHex.length})`);
  }
  const key = Buffer.from(shareKeyHex, "hex");
  const iv = Buffer.from(cleanHex.slice(8, 32), "hex");
  const authTag = Buffer.from(cleanHex.slice(32, 64), "hex");
  const ciphertext = Buffer.from(cleanHex.slice(64), "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.alloc(16, 0));
  decipher.setAuthTag(authTag);
  const decoded = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

  const respIdx = decoded.indexOf("<response>");
  return respIdx >= 0 ? decoded.slice(respIdx) : decoded;
}

const XSS_ENCODE_MAP = {
  "&": "&amp;",
  "'": "&#39;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
  "/": "&#x2F;",
  "(": "&#40;",
  ")": "&#41;",
};

const XSS_DECODE_MAP = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&#39;": "'",
  "&quot;": '"',
  "&#x2F;": "/",
  "&#x2f;": "/",
  "&#40;": "(",
  "&#41;": ")",
  "&apos;": "'",
};

/**
 * Encode text with Huawei WebUI's exact `xss()` escaping (`main_crypto.js` `b()`).
 * Note: `<Length>` in `/api/sms/send-sms` must equal `huaweiXssEncode(text).length`!
 *
 * @param {string} input
 * @returns {string}
 */
export function huaweiXssEncode(input) {
  if (typeof input === "number") return String(input);
  if (typeof input !== "string") return "";
  return input.replace(/[&'"<>\/()]/g, (ch) => XSS_ENCODE_MAP[ch] ?? ch);
}

/**
 * Decode Huawei XML/XSS entities back to plain text.
 *
 * @param {string} input
 * @returns {string}
 */
export function huaweiXssDecode(input) {
  if (!input) return "";
  return input.replace(
    /(&lt;|&gt;|&amp;|&#39;|&quot;|&#x2F;|&#x2f;|&#40;|&#41;|&apos;|&#(\d+);|&#x([0-9a-fA-F]+);)/g,
    (full, _entity, dec, hex) => {
      if (XSS_DECODE_MAP[full]) return XSS_DECODE_MAP[full];
      if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return full;
    }
  );
}

/**
 * Strip invalid ASCII control chars except `\t`, `\n`, `\r` (`main_crypto.js`).
 *
 * @param {string} text
 * @returns {string}
 */
export function stripInvalidControlChars(text) {
  if (typeof text !== "string") return "";
  return text.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, "");
}

/**
 * Determine Huawei `<Reserved>` SMS encoding mode (`1` = GSM 7-bit, `0` = UCS-2)
 * and estimated segment count, matching `smsSendPage.vue` (`mod_381.js`).
 *
 * @param {string} content
 * @returns {{ textMode: 0 | 1, encoding: "7BIT" | "UCS2", segments: number, charUnits: number }}
 */
export function detectSmsTextMode(content) {
  const clean = stripInvalidControlChars(content);
  let hasUcs2 = false;
  let septets = 0;

  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    if (GSM_7BIT_DEFAULT_TABLE.has(code)) {
      septets += 1;
    } else if (GSM_7BIT_EXT_TABLE.has(code)) {
      septets += 2;
    } else {
      hasUcs2 = true;
      break;
    }
  }

  if (hasUcs2) {
    const units = clean.length;
    const segments = units <= 70 ? 1 : Math.ceil(units / 67);
    return {
      textMode: SMS_TEXT_MODE_UCS2,
      encoding: "UCS2",
      segments,
      charUnits: units,
    };
  }

  const segments = septets <= 160 ? 1 : Math.ceil(septets / 153);
  return {
    textMode: SMS_TEXT_MODE_7BIT,
    encoding: "7BIT",
    segments,
    charUnits: septets,
  };
}

const OTP_CONTEXT_RE =
  /(验证码|校验码|动态码|确认码|随机码|认证码|登录码|提取码|verification|verify|passcode|security\s*code|auth(?:entication)?\s*code|one[-\s]*time|\botp\b|\bpin\b|\bcode\b)/i;

/**
 * Extract likely 4-8 digit OTP / verification code from SMS content for one-tap copying.
 * Returns `null` if the SMS does not appear to contain a verification code.
 *
 * @param {string} content
 * @returns {string | null}
 */
export function extractVerificationCode(content) {
  if (!content || !OTP_CONTEXT_RE.test(content)) return null;

  // Prefer codes immediately adjacent to keywords like `验证码：123456` or `code is 849201`
  const directPatterns = [
    /(?:验证码|校验码|动态码|确认码|随机码|认证码|登录码|passcode|otp|code)\s*(?:为|是|[:：]|is)?\s*([0-9]{4,8})(?![0-9])/i,
    /\b([0-9]{4,8})\s*(?:is your|为您的|是您的|为本次)/i,
  ];
  for (const re of directPatterns) {
    const m = content.match(re);
    if (m?.[1]) return m[1];
  }

  // Fallback: find standalone 4-8 digit numbers excluding dates, years, times, or URLs
  const sanitized = content
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b20[2-3][0-9][-/.][01]?[0-9][-/.][0-3]?[0-9]\b/g, " ")
    .replace(/\b[0-2]?[0-9]:[0-5][0-9](?::[0-5][0-9])?\b/g, " ");

  const candidates = [...sanitized.matchAll(/(?<![0-9.+-])([0-9]{4,8})(?![0-9.%元GBMB])/g)].map(
    (m) => m[1]
  );
  return candidates[0] ?? null;
}
