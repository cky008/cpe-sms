import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageCipher } from "../src/encrypted-file.ts";

test("StorageCipher encrypts JSON at rest with AES-256-GCM and never stores plaintext on disk", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-enc-test-"));
  const filePath = path.join(tmpDir, "archive.json");

  try {
    const cipher = new StorageCipher("my-strong-cpe-secret");
    const secretPayload = {
      version: 1,
      messages: [
        {
          uid: "cpe:40001",
          phone: "+353831234567",
          content: "【Apple】您的验证码是 849201",
        },
      ],
    };

    cipher.writeJsonFile(filePath, secretPayload);

    // Raw file on disk MUST be an encrypted envelope with zero plaintext phone/OTP leak!
    const rawDiskText = fs.readFileSync(filePath, "utf8");
    assert.equal(rawDiskText.includes("849201"), false);
    assert.equal(rawDiskText.includes("+353831234567"), false);

    const envelope = JSON.parse(rawDiskText);
    assert.equal(envelope.__encrypted, "cpe-sms-aes-256-gcm-v1");
    assert.equal(typeof envelope.salt, "string");
    assert.equal(typeof envelope.iv, "string");
    assert.equal(typeof envelope.tag, "string");
    assert.equal(typeof envelope.ciphertext, "string");

    // Roundtrip decryption with another StorageCipher instance using the same secret
    const cipherReloaded = new StorageCipher("my-strong-cpe-secret");
    const decoded = cipherReloaded.readJsonFile<typeof secretPayload>(filePath);
    assert.deepEqual(decoded, secretPayload);

    // Every write generates fresh random salt & IV
    cipher.writeJsonFile(filePath, secretPayload);
    const envelope2 = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.notEqual(envelope2.iv, envelope.iv);
    assert.notEqual(envelope2.salt, envelope.salt);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("StorageCipher rejects wrong key and detects ciphertext tampering", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-enc-tamper-"));
  const filePath = path.join(tmpDir, "state.json");

  try {
    const rightCipher = new StorageCipher("correct-secret");
    const wrongCipher = new StorageCipher("wrong-secret");

    rightCipher.writeJsonFile(filePath, { authorizedChatIds: ["123456"] });

    assert.throws(() => wrongCipher.readJsonFile(filePath), /decrypt|Unsupported state|unable to authenticate/i);

    // Tamper with ciphertext
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    raw.ciphertext =
      raw.ciphertext.slice(0, -2) + (raw.ciphertext.slice(-2) === "ff" ? "00" : "ff");
    fs.writeFileSync(filePath, JSON.stringify(raw), "utf8");

    assert.throws(() => rightCipher.readJsonFile(filePath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("StorageCipher transparently reads legacy plaintext JSON and upgrades to encrypted on write", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-enc-migrate-"));
  const filePath = path.join(tmpDir, "contacts.json");

  try {
    const legacyPlaintext = {
      version: 1,
      contacts: [{ id: "1", name: "Sean", phones: ["+353839990000"] }],
    };
    fs.writeFileSync(filePath, JSON.stringify(legacyPlaintext, null, 2), "utf8");

    const cipher = new StorageCipher("upgrade-key-2026");
    const loaded = cipher.readJsonFile<typeof legacyPlaintext>(filePath);
    assert.deepEqual(loaded, legacyPlaintext);

    // Next save encrypts it at rest
    cipher.writeJsonFile(filePath, loaded!);
    const afterSave = fs.readFileSync(filePath, "utf8");
    assert.equal(afterSave.includes("+353839990000"), false);
    assert.match(afterSave, /cpe-sms-aes-256-gcm-v1/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
