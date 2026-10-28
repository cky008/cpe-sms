import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { loadConfig, normalizeCpeUrl, parseDotEnv } from "../src/config.ts";
import {
  SMS_TEXT_MODE_7BIT,
  SMS_TEXT_MODE_UCS2,
  aesGcmDecrypt,
  aesGcmEncrypt,
  computeScram,
  curve25519Mul,
  detectSmsTextMode,
  extractVerificationCode,
  generateEccSession,
  huaweiXssDecode,
  huaweiXssEncode,
  stripInvalidControlChars,
  verifyPubkeySignature,
} from "../src/crypto.ts";
import {
  buildXmlRequest,
  escapeXmlBasic,
  formatHuaweiDate,
  getXmlBlocks,
  getXmlTag,
  getXmlTextPreserve,
  jsonToXml,
  parseXmlError,
} from "../src/xml.ts";

test("Curve25519 unclamped Montgomery ECDH satisfies commutativity, edge guards, and 64-hex invariant", () => {
  assert.equal(curve25519Mul(0n, 9n), 0n);
  assert.throws(() => generateEccSession(""), /Invalid CPE ECC/);
  assert.throws(() => generateEccSession("00"), /Rejected weak CPE ECC/);

  const serverPriv = BigInt("0x09a1b2c3d4e5f60718293a4b5c6d7e8f0123456789abcdef0123456789abcdef");
  const serverPub = curve25519Mul(serverPriv, 9n).toString(16).padStart(64, "0");

  const session = generateEccSession(serverPub);
  assert.equal(session.clientPubHex.length, 64);
  assert.equal(session.shareKeyHex.length, 64);

  const serverSideShared = curve25519Mul(
    serverPriv,
    BigInt(`0x${session.clientPubHex}`)
  ).toString(16);
  assert.equal(serverSideShared, session.shareKeyHex);
});

test("Huawei SCRAM-SHA256 proof and ECC pubkey signature verification", () => {
  const saltHex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const firstNonce = "aa".repeat(32);
  const serverNonce = `${firstNonce}${"bb".repeat(16)}`;
  const scram = computeScram("MyCpePass!2026", saltHex, 1000, firstNonce, serverNonce);

  assert.equal(scram.clientProofHex.length, 64);
  assert.equal(scram.expectedServerSig.length, 64);

  const fakeEccPub = "8f".repeat(32);
  const validSig = crypto
    .createHmac("sha256", scram.serverKey)
    .update(Buffer.from(fakeEccPub, "hex"))
    .digest("hex");

  assert.equal(verifyPubkeySignature(fakeEccPub, scram.serverKey, validSig), true);
  assert.equal(verifyPubkeySignature(fakeEccPub, scram.serverKey, "00".repeat(32)), false);
  assert.equal(verifyPubkeySignature("", scram.serverKey, validSig), false);
});

test("AES-256-GCM wire format encrypt/decrypt roundtrip and tamper detection", () => {
  const shareKeyHex = "ab".repeat(32);
  assert.equal(aesGcmEncrypt("", shareKeyHex), "");
  assert.throws(() => aesGcmDecrypt("short", shareKeyHex), /Invalid AES-GCM/);

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?><response><Count>1</Count><messages><message><phone>10086</phone><content>【中国移动】您的验证码是 839201，5分钟内有效。</content></message></messages></response>';

  const packed = aesGcmEncrypt(xml, shareKeyHex);
  assert.match(packed, /^[0-9a-f]+$/);

  const expectedUtf8Len = Buffer.byteLength(xml, "utf8");
  const encodedLen = Buffer.from(packed.slice(0, 8), "hex").readUInt32LE(0);
  assert.equal(encodedLen, expectedUtf8Len);

  const decrypted = aesGcmDecrypt(packed, shareKeyHex);
  assert.equal(decrypted.startsWith("<response>"), true);
  assert.equal(decrypted.includes("839201"), true);

  const flipped = packed.slice(0, -2) + (packed.slice(-2) === "ff" ? "00" : "ff");
  assert.throws(() => aesGcmDecrypt(flipped, shareKeyHex));
});

test("Huawei XSS encode/decode, control char stripper, and XML helpers", () => {
  const raw = `Url: https://example.com/a?x=1&y=2 (code '99' "ok") <tag>`;
  const encoded = huaweiXssEncode(raw);
  assert.equal(huaweiXssEncode(42), "42");
  assert.equal(encoded.includes("&#x2F;"), true);
  assert.equal(encoded.includes("&#40;"), true);
  assert.equal(encoded.includes("&amp;"), true);
  assert.equal(huaweiXssDecode(encoded), raw);
  assert.equal(huaweiXssDecode("&#65;&#x42;&apos;"), "AB'");
  assert.equal(stripInvalidControlChars("a\x00b\nc"), "ab\nc");

  // XML helpers
  const reqXml = buildXmlRequest({
    Index: [1, 2],
    Phones: { Phone: escapeXmlBasic("<+353&'\"1>") },
    Empty: null,
  });
  assert.match(reqXml, /<Index>1<\/Index><Index>2<\/Index>/);
  assert.equal(jsonToXml("flag", true), "<flag>true</flag>");
  assert.equal(getXmlTag("", "a"), null);
  assert.deepEqual(getXmlBlocks("", "a"), []);
  assert.equal(getXmlTextPreserve("<m><content>  hi\r\n  </content></m>"), "  hi\n  ");

  const errParsed = parseXmlError(
    "<error><code>108006</code><message>bad</message><remaincount>2</remaincount><waittime>5</waittime></error>"
  );
  assert.deepEqual(errParsed, { code: "108006", message: "bad", remainCount: 2, waitTime: 5 });
  assert.equal(parseXmlError("<response>OK</response>"), null);
  assert.match(formatHuaweiDate(new Date("2026-10-27T12:34:56Z")), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("SMS text mode detector distinguishes GSM 7-bit, extension table (€/[]), and UCS-2", () => {
  const ascii = detectSmsTextMode("Hello Three €10 [ok]");
  assert.equal(ascii.textMode, SMS_TEXT_MODE_7BIT);
  assert.equal(ascii.segments, 1);

  const longAscii = detectSmsTextMode("A".repeat(161));
  assert.equal(longAscii.textMode, SMS_TEXT_MODE_7BIT);
  assert.equal(longAscii.segments, 2);

  const chinese = detectSmsTextMode("你好，这是一条测试短信");
  assert.equal(chinese.textMode, SMS_TEXT_MODE_UCS2);
  assert.equal(chinese.segments, 1);

  const longChinese = detectSmsTextMode("中".repeat(71));
  assert.equal(longChinese.textMode, SMS_TEXT_MODE_UCS2);
  assert.equal(longChinese.segments, 2);
});

test("Verification code extractor identifies OTPs without false positives", () => {
  assert.equal(
    extractVerificationCode("【Apple】您的 Apple 账户验证码为：492817。请勿向他人泄露。"),
    "492817"
  );
  assert.equal(
    extractVerificationCode("884422 is your security code for login."),
    "884422"
  );
  assert.equal(
    extractVerificationCode("Please enter verification number on 2026-10-27 12:30: 556677"),
    "556677"
  );
  assert.equal(
    extractVerificationCode("尊敬的客户，您本月已使用流量 1280MB，话费余额 2026 元。"),
    null
  );
});

test("Config URL normalizer and dotenv parser handle quotes, exports, booleans, and overrides", () => {
  assert.equal(normalizeCpeUrl("http://192.168.8.1/#/sms"), "http://192.168.8.1");
  assert.equal(normalizeCpeUrl("192.168.8.1/"), "http://192.168.8.1");
  const parsed = parseDotEnv(
    'export CPE_PASSWORD="my \\"pass\\""\nSINGLE=\'val\'\nTELEGRAM_API=123:abc # comment\n'
  );
  assert.equal(parsed.CPE_PASSWORD, 'my "pass"');
  assert.equal(parsed.SINGLE, "val");
  assert.equal(parsed.TELEGRAM_API, "123:abc");

  const cfg = loadConfig({
    envPath: "/nonexistent/.env",
    ignoreProcessEnv: true,
    overrides: {
      CPE_URL: "192.168.8.1",
      CPE_PASSWORD: "pw",
      DEFAULT_COUNTRY_CODE: "353",
      WEB_ENABLED: "false",
      AUTO_MARK_READ: "yes",
      HTTP_PORT: "18080",
    },
  });
  assert.equal(cfg.defaultCountryCode, "+353");
  assert.equal(cfg.webEnabled, false);
  assert.equal(cfg.autoMarkRead, true);
  assert.equal(cfg.httpPort, 18080);
});
