import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types.ts";

export interface LoadConfigOptions {
  envPath?: string;
  overrides?: Record<string, string>;
  ignoreProcessEnv?: boolean;
}

/**
 * Parse a `.env` file string into key-value pairs without mutating `process.env`.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eqIdx = cleaned.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = cleaned.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = cleaned.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    } else {
      const commentIdx = value.indexOf(" #");
      if (commentIdx >= 0) {
        value = value.slice(0, commentIdx).trim();
      }
    }
    result[key] = value;
  }
  return result;
}

/**
 * Normalize CPE base URL (strip hash routes like `#/sms` and trailing slashes).
 */
export function normalizeCpeUrl(rawUrl: string): string {
  let url = (rawUrl || "http://192.168.8.1").trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

function parseBool(val: string | undefined, defaultValue: boolean): boolean {
  if (val === undefined || val === "") return defaultValue;
  const v = val.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

function parseIntSafe(val: string | undefined, defaultValue: number): number {
  if (val === undefined || val === "") return defaultValue;
  const n = Number.parseInt(val, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * Load application configuration from `.env` and `process.env`.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const envPath = options.envPath ?? path.resolve(process.cwd(), ".env");
  let fileEnv: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    fileEnv = parseDotEnv(fs.readFileSync(envPath, "utf8"));
  }

  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      if (options.overrides?.[k] !== undefined && options.overrides[k] !== "") {
        return options.overrides[k];
      }
      if (!options.ignoreProcessEnv && process.env[k] !== undefined && process.env[k] !== "") {
        return process.env[k];
      }
      if (fileEnv[k] !== undefined && fileEnv[k] !== "") {
        return fileEnv[k];
      }
    }
    return undefined;
  };

  const cpeUrl = normalizeCpeUrl(get("CPE_URL", "CPE_HOST") ?? "http://192.168.8.1");
  const cpeUsername = get("CPE_USERNAME", "CPE_USER") ?? "admin";
  const cpePassword = get("CPE_PASSWORD", "CPEPASSWORD") ?? "";
  const dataEncryptionKey = get("DATA_ENCRYPTION_KEY") ?? cpePassword;
  const telegramToken = get("TELEGRAM_API", "TELEGRAM_BOT_TOKEN") ?? "";
  const telegramApiBase = (get("TELEGRAM_API_BASE") ?? "https://api.telegram.org").replace(/\/+$/, "");

  const rawChatIds = get("TELEGRAM_CHAT_IDS", "TELEGRAM_CHAT_ID") ?? "";
  const telegramChatIds = rawChatIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const rawCountry = (get("DEFAULT_COUNTRY_CODE") ?? "+353").trim();
  const defaultCountryCode = rawCountry.startsWith("+") ? rawCountry : `+${rawCountry}`;

  const pollIntervalMs = Math.max(2000, parseIntSafe(get("POLL_INTERVAL_MS"), 5000));
  const fullSyncIntervalMs = Math.max(15000, parseIntSafe(get("FULL_SYNC_INTERVAL_MS"), 60000));
  const requestTimeoutMs = Math.max(5000, parseIntSafe(get("REQUEST_TIMEOUT_MS"), 20000));
  const seedExistingOnStart = parseBool(get("SEED_EXISTING_ON_START"), true);
  const autoMarkRead = parseBool(get("AUTO_MARK_READ"), false);

  const stateFile = path.resolve(process.cwd(), get("STATE_FILE") ?? "./data/state.json");
  const dataDir = path.dirname(stateFile);
  const archiveFile = path.resolve(
    process.cwd(),
    get("ARCHIVE_FILE") ?? path.join(dataDir, "sms-archive.json")
  );
  const contactsFile = path.resolve(
    process.cwd(),
    get("CONTACTS_FILE") ?? path.join(dataDir, "contacts.json")
  );

  // Real-time daisyUI Web UI + REST API unified on high port 18383 by default
  const webEnabled = parseBool(get("WEB_ENABLED", "WEB_UI_ENABLED"), true);
  const webPort = Math.max(0, parseIntSafe(get("WEB_PORT"), 18383));
  const webHost = get("WEB_HOST") ?? "0.0.0.0";
  const webUpstreamUrl = (get("WEB_UPSTREAM_URL") ?? "").replace(/\/+$/, "");

  // Separate headless HTTP port defaults to 0 (disabled) so port 8080 is never occupied on NAS
  const httpPort = Math.max(0, parseIntSafe(get("HTTP_PORT", "API_PORT"), 0));
  const httpHost = get("HTTP_HOST") ?? "0.0.0.0";
  const apiToken = get("API_TOKEN") ?? cpePassword;
  const webhookUrl = get("WEBHOOK_URL") ?? "";

  return {
    cpeUrl,
    cpeUsername,
    cpePassword,
    dataEncryptionKey,
    telegramToken,
    telegramApiBase,
    telegramChatIds,
    defaultCountryCode,
    pollIntervalMs,
    fullSyncIntervalMs,
    requestTimeoutMs,
    seedExistingOnStart,
    autoMarkRead,
    stateFile,
    archiveFile,
    contactsFile,
    webEnabled,
    webPort,
    webHost,
    webUpstreamUrl,
    httpPort,
    httpHost,
    apiToken,
    webhookUrl,
  };
}
