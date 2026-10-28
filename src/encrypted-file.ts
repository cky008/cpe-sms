import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ENVELOPE_MAGIC = "cpe-sms-aes-256-gcm-v1";
const AAD_BYTES = Buffer.from(ENVELOPE_MAGIC, "utf8");
const MASTER_KDF_SALT = Buffer.from("cpe-sms-kdf-master-v1", "utf8");
const HKDF_INFO = Buffer.from("cpe-sms-at-rest-subkey-v1", "utf8");

export interface EncryptedFileEnvelope {
  __encrypted: typeof ENVELOPE_MAGIC;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

const masterKeyCache = new Map<string, Buffer>();

function deriveMasterKey(secret: string): Buffer {
  const cached = masterKeyCache.get(secret);
  if (cached) return cached;
  const derived = crypto.scryptSync(Buffer.from(secret, "utf8"), MASTER_KDF_SALT, 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
  masterKeyCache.set(secret, derived);
  return derived;
}

function isEncryptedEnvelope(val: unknown): val is EncryptedFileEnvelope {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  return (
    obj.__encrypted === ENVELOPE_MAGIC &&
    typeof obj.salt === "string" &&
    typeof obj.iv === "string" &&
    typeof obj.tag === "string" &&
    typeof obj.ciphertext === "string"
  );
}

/**
 * Authenticated AES-256-GCM at-rest JSON storage cipher.
 *
 * - Stretches the master secret via `scrypt` (`N=16384, r=8, p=1`).
 * - Generates a fresh 16-byte salt (HKDF-SHA256 subkey) and 12-byte IV on every write.
 * - Atomically writes `0o600` files via temp-file rename.
 * - Transparently migrates legacy plaintext JSON files on first read/write.
 */
export class StorageCipher {
  readonly enabled: boolean;
  readonly #masterKey: Buffer | null;

  constructor(secret: string, allowDisabled = false) {
    if (!secret || !secret.trim()) {
      if (allowDisabled) {
        this.enabled = false;
        this.#masterKey = null;
        return;
      }
      throw new Error("StorageCipher requires a non-empty secret key");
    }
    this.enabled = true;
    this.#masterKey = deriveMasterKey(secret);
  }

  /**
   * Create an active `StorageCipher` when `secret` is non-empty, or a plaintext fallback
   * for isolated unit tests that do not supply a secret.
   */
  static fromSecret(secret?: string): StorageCipher {
    return new StorageCipher(secret ?? "", true);
  }

  encryptObject(data: unknown): EncryptedFileEnvelope {
    if (!this.enabled || !this.#masterKey) {
      throw new Error("StorageCipher is not enabled");
    }
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const subKey = Buffer.from(
      crypto.hkdfSync("sha256", this.#masterKey, salt, HKDF_INFO, 32)
    );

    const plainBytes = Buffer.from(JSON.stringify(data), "utf8");
    const cipher = crypto.createCipheriv("aes-256-gcm", subKey, iv);
    cipher.setAAD(AAD_BYTES);
    const ciphertext = Buffer.concat([cipher.update(plainBytes), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      __encrypted: ENVELOPE_MAGIC,
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  decryptEnvelope<T = unknown>(envelope: EncryptedFileEnvelope): T {
    if (!this.enabled || !this.#masterKey) {
      throw new Error("Cannot decrypt encrypted storage file without DATA_ENCRYPTION_KEY / CPE_PASSWORD");
    }
    const salt = Buffer.from(envelope.salt, "hex");
    const iv = Buffer.from(envelope.iv, "hex");
    const tag = Buffer.from(envelope.tag, "hex");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");

    const subKey = Buffer.from(
      crypto.hkdfSync("sha256", this.#masterKey, salt, HKDF_INFO, 32)
    );
    const decipher = crypto.createDecipheriv("aes-256-gcm", subKey, iv);
    decipher.setAAD(AAD_BYTES);
    decipher.setAuthTag(tag);
    const plainBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plainBytes.toString("utf8")) as T;
  }

  readJsonFile<T = unknown>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) return null;
    const rawText = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(rawText);
    if (isEncryptedEnvelope(parsed)) {
      return this.decryptEnvelope<T>(parsed);
    }
    // Transparent read of legacy plaintext JSON (will be encrypted on next writeJsonFile)
    return parsed as T;
  }

  writeJsonFile(filePath: string, data: unknown): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const suffix = crypto.randomBytes(4).toString("hex");
    const tmpFile = `${filePath}.${process.pid}.${suffix}.tmp`;

    const serialized = this.enabled
      ? JSON.stringify(this.encryptObject(data), null, 2)
      : JSON.stringify(data, null, 2);

    fs.writeFileSync(tmpFile, serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpFile, filePath);
  }
}
