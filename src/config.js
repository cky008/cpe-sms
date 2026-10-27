import fs from "node:fs";
import path from "node:path";

/**
 * Parse a `.env` file string into key-value pairs without mutating `process.env`
 * for keys that are already explicitly set in the environment.
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseDotEnv(content) {
  /** @type {Record<string, string>} */
  const result = {};
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
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function normalizeCpeUrl(rawUrl) {
  let url = (rawUrl || "http://192.168.8.1").trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * Parse boolean environment string.
 *
 * @param {string | undefined} val
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function parseBool(val, defaultValue) {
  if (val === undefined || val === "") return defaultValue;
  const v = val.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

/**
 * Parse integer environment string.
 *
 * @param {string | undefined} val
 * @param {number} defaultValue
 * @returns {number}
 */
function parseIntSafe(val, defaultValue) {
  if (val === undefined || val === "") return defaultValue;
  const n = Number.parseInt(val, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * Load application configuration from `.env` and `process.env`.
 *
 * @param {{ envPath?: string, overrides?: Record<string, string> }} [options]
 */
export function loadConfig(options = {}) {
  const envPath = options.envPath ?? path.resolve(process.cwd(), ".env");
  /** @type {Record<string, string>} */
  let fileEnv = {};
  if (fs.existsSync(envPath)) {
    fileEnv = parseDotEnv(fs.readFileSync(envPath, "utf8"));
  }

  const get = (/** @type {string[]} */ ...keys) => {
    for (const k of keys) {
      if (options.overrides?.[k] !== undefined && options.overrides[k] !== "") {
        return options.overrides[k];
      }
      if (process.env[k] !== undefined && process.env[k] !== "") {
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
  const telegramToken = get("TELEGRAM_API", "TELEGRAM_BOT_TOKEN") ?? "";
  const telegramApiBase = (get("TELEGRAM_API_BASE") ?? "https://api.telegram.org").replace(/\/+$/, "");

  const rawChatIds = get("TELEGRAM_CHAT_IDS", "TELEGRAM_CHAT_ID") ?? "";
  const telegramChatIds = rawChatIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const pollIntervalMs = Math.max(2000, parseIntSafe(get("POLL_INTERVAL_MS"), 5000));
  const fullSyncIntervalMs = Math.max(15000, parseIntSafe(get("FULL_SYNC_INTERVAL_MS"), 60000));
  const requestTimeoutMs = Math.max(5000, parseIntSafe(get("REQUEST_TIMEOUT_MS"), 20000));
  const seedExistingOnStart = parseBool(get("SEED_EXISTING_ON_START"), true);
  const autoMarkRead = parseBool(get("AUTO_MARK_READ"), false);
  const stateFile = path.resolve(process.cwd(), get("STATE_FILE") ?? "./data/state.json");

  const httpPort = Math.max(0, parseIntSafe(get("HTTP_PORT", "API_PORT"), 8080));
  const httpHost = get("HTTP_HOST") ?? "0.0.0.0";
  const apiToken = get("API_TOKEN") ?? cpePassword;
  const webhookUrl = get("WEBHOOK_URL") ?? "";

  return {
    cpeUrl,
    cpeUsername,
    cpePassword,
    telegramToken,
    telegramApiBase,
    telegramChatIds,
    pollIntervalMs,
    fullSyncIntervalMs,
    requestTimeoutMs,
    seedExistingOnStart,
    autoMarkRead,
    stateFile,
    httpPort,
    httpHost,
    apiToken,
    webhookUrl,
  };
}
