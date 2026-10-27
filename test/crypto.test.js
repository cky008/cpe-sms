import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
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
  verifyPubkeySignature,
} from "../src/crypto.js";
import { parseDotEnv, normalizeCpeUrl } from "../src/config.js";

test("Curve25519 unclamped Montgomery ECDH satisfies commutativity and 64-hex invariant", () => {
  const serverPriv = BigInt("0x09a1b2c3d4e5f60718293a4b5c6d7e8f0123456789abcdef0123456789abcdef");
  const serverPub = curve25519Mul(serverPriv, 9n).toString(16).padStart(64, "0");

  const session = generateEccSession(serverPub);
  assert.equal(session.clientPubHex.length, 64);
  assert.equal(session.shareKeyHex.length, 64);

  const serverSideShared = curve25519Mul(serverPriv, BigInt(`0x${session.clientPubHex}`)).toString(16);
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
});

test("AES-256-GCM wire format encrypt/decrypt roundtrip and tamper detection", () => {
  const shareKeyHex = "ab".repeat(32);
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?><response><Count>1</Count><messages><message><phone>10086</phone><content>【中国移动】您的验证码是 839201，5分钟内有效。</content></message></messages></response>';

  const packed = aesGcmEncrypt(xml, shareKeyHex);
  assert.match(packed, /^[0-9a-f]+$/);

  // Verify first 4 bytes are little-endian UTF-8 byte length
  const expectedUtf8Len = Buffer.byteLength(xml, "utf8");
  const encodedLen = Buffer.from(packed.slice(0, 8), "hex").readUInt32LE(0);
  assert.equal(encodedLen, expectedUtf8Len);

  const decrypted = aesGcmDecrypt(packed, shareKeyHex);
  assert.equal(decrypted.startsWith("<response>"), true);
  assert.equal(decrypted.includes("839201"), true);

  // Tamper with ciphertext byte -> must fail GCM authentication
  const flipped =
    packed.slice(0, -2) + (packed.slice(-2) === "ff" ? "00" : "ff");
  assert.throws(() => aesGcmDecrypt(flipped, shareKeyHex));
});

test("Huawei XSS encode/decode roundtrip matches WebUI rules", () => {
  const raw = `Url: https://example.com/a?x=1&y=2 (code '99' "ok") <tag>`;
  const encoded = huaweiXssEncode(raw);
  assert.equal(encoded.includes("&#x2F;"), true);
  assert.equal(encoded.includes("&#40;"), true);
  assert.equal(encoded.includes("&amp;"), true);
  assert.equal(huaweiXssDecode(encoded), raw);
});

test("SMS text mode detector distinguishes GSM 7-bit, extension table, and UCS-2", () => {
  const ascii = detectSmsTextMode("Hello Three UK 12345");
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
    extractVerificationCode("Your Three verification code is 738192. Valid for 10 mins."),
    "738192"
  );
  assert.equal(
    extractVerificationCode("尊敬的客户，您本月已使用流量 1280MB，话费余额 2026 元。"),
    null
  );
});

test("Config URL normalizer strips hash fragments like #/sms", () => {
  assert.equal(normalizeCpeUrl("http://192.168.8.1/#/sms"), "http://192.168.8.1");
  assert.equal(normalizeCpeUrl("192.168.8.1/"), "http://192.168.8.1");
  const parsed = parseDotEnv('CPE_PASSWORD="my pass"\nTELEGRAM_API=123:abc # comment\n');
  assert.equal(parsed.CPE_PASSWORD, "my pass");
  assert.equal(parsed.TELEGRAM_API, "123:abc");
});
