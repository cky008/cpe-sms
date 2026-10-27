import crypto from "node:crypto";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  computeScram,
  detectSmsTextMode,
  generateEccSession,
  huaweiXssEncode,
  stripInvalidControlChars,
  verifyPubkeySignature,
} from "./crypto.js";
import {
  buildXmlRequest,
  escapeXmlBasic,
  formatHuaweiDate,
  getXmlBlocks,
  getXmlTag,
  getXmlTextPreserve,
  parseXmlError,
} from "./xml.js";

/**
 * Known Huawei HiLink error codes for clear diagnostics.
 */
export const CPE_ERROR_DESCRIPTIONS = {
  "100002": "系统不支持该接口 (No support)",
  "100003": "权限不足或未登录 (Unauthorized)",
  "100004": "系统繁忙 (System busy)",
  "100005": "数据格式错误 (Format error)",
  "100006": "参数错误 (Parameter error)",
  "108001": "用户名错误 (Wrong username)",
  "108002": "密码错误 (Wrong password)",
  "108003": "已有其他用户登录管理后台 (Already logged in)",
  "108005": "重复登录冲突 (Duplicate login)",
  "108006": "登录密码错误 (Authentication failed)",
  "108007": "密码错误次数过多，账户已暂时锁定 (Login locked)",
  "108009": "已有其他终端登录管理后台 (Session occupied)",
  "108010": "登录过于频繁，请稍后重试 (Too frequent login)",
  "113018": "短信发送超时或信号异常 (SMS send timeout)",
  "113049": "SIM 卡不支持发送短信或欠费 (SIM card SMS send failed)",
  "120001": "语音通话占线中 (Voice busy)",
  "125001": "CSRF Token 校验失败 (Wrong token)",
  "125002": "会话已过期 (Session expired)",
  "125003": "会话 Token 无效 (Invalid session token)",
};

export class CpeApiError extends Error {
  /**
   * @param {string} code
   * @param {string} [detail]
   * @param {{ remainCount?: number | null, waitTime?: number | null }} [meta]
   */
  constructor(code, detail = "", meta = {}) {
    const desc = CPE_ERROR_DESCRIPTIONS[code] ?? "CPE 接口错误";
    const suffix = detail ? `: ${detail}` : "";
    super(`[CPE ${code}] ${desc}${suffix}`);
    this.name = "CpeApiError";
    this.code = code;
    this.remainCount = meta.remainCount ?? null;
    this.waitTime = meta.waitTime ?? null;
  }

  get isAuthWrongPassword() {
    return this.code === "108006" || this.code === "108002" || this.code === "108001";
  }

  get isLocked() {
    return this.code === "108007";
  }

  get isSessionOccupied() {
    return this.code === "108003" || this.code === "108005" || this.code === "108009";
  }
}

/**
 * Check whether a recipient string is a dialable phone number (digits with optional leading `+`),
 * distinguishing it from alphanumeric carrier sender IDs like `Apple` or `Three`.
 *
 * @param {string} phone
 * @returns {boolean}
 */
export function isDialablePhone(phone) {
  if (!phone) return false;
  const cleaned = phone.trim().replace(/[\s-]/g, "");
  return /^\+?[0-9]{3,20}$/.test(cleaned);
}

/**
 * Normalize dialable phone numbers (strip spaces/hyphens).
 *
 * @param {string} phone
 * @returns {string}
 */
export function normalizePhone(phone) {
  return (phone || "").trim().replace(/[\s-]/g, "");
}

/**
 * Parse a `<message>` / `<Message>` XML block into a unified SMS object.
 *
 * @param {string} block
 * @param {"0" | "1" | null} [defaultCurbox]
 * @returns {{
 *   index: number,
 *   phone: string,
 *   content: string,
 *   date: string,
 *   smstat: string,
 *   smstype: string,
 *   curbox: string,
 *   isUnread: boolean,
 *   direction: "in" | "out"
 * }}
 */
export function parseSmsMessageBlock(block, defaultCurbox = null) {
  const indexStr = getXmlTag(block, "index") ?? "0";
  const phone = getXmlTag(block, "phone") ?? "";
  const content = getXmlTextPreserve(block, "content");
  const date = getXmlTag(block, "date") ?? "";
  const smstat = getXmlTag(block, "smstat") ?? "1";
  const smstype = getXmlTag(block, "smstype") ?? "1";
  const curbox =
    getXmlTag(block, "curbox") ??
    defaultCurbox ??
    (smstat === "3" || smstat === "4" ? "1" : "0");

  return {
    index: Number.parseInt(indexStr, 10) || 0,
    phone,
    content,
    date,
    smstat,
    smstype,
    curbox,
    isUnread: smstat === "0" && curbox !== "1",
    direction: curbox === "1" || smstat === "3" || smstat === "4" ? "out" : "in",
  };
}

/**
 * Internal ephemeral session bound to a single `login -> action -> logout` lifecycle.
 */
class EphemeralCpeSession {
  /**
   * @param {{
   *   baseUrl: string,
   *   username: string,
   *   password: string,
   *   timeoutMs: number,
   *   fetchImpl: typeof fetch
   * }} opts
   */
  constructor(opts) {
    this.baseUrl = opts.baseUrl;
    this.username = opts.username;
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl;
    /** @type {Map<string, string>} */
    this.cookies = new Map();
    /** @type {string[]} */
    this.tokens = [];
    /** @type {{ clientPubHex: string, shareKeyHex: string } | null} */
    this.ecc = null;
    this.loggedIn = false;
  }

  /**
   * @param {Headers} headers
   */
  #updateCookies(headers) {
    const rawList =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : headers.get("set-cookie")
          ? [headers.get("set-cookie")]
          : [];
    for (const raw of rawList) {
      if (!raw) continue;
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }

  #cookieHeader() {
    if (this.cookies.size === 0) return "";
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /**
   * @param {Headers} headers
   * @param {boolean} clearFirst
   */
  #captureTokens(headers, clearFirst = false) {
    if (clearFirst) {
      this.tokens = [];
    }
    const t1 = headers.get("__requestverificationtokenone");
    const t2 = headers.get("__requestverificationtokentwo");
    const t0 = headers.get("__requestverificationtoken");
    if (t1) {
      this.tokens.push(t1.trim());
      if (t2) this.tokens.push(t2.trim());
    } else if (t0) {
      this.tokens.push(t0.trim());
    }
  }

  /**
   * Perform an HTTP GET inside this session.
   *
   * @param {string} apiPath
   * @param {Record<string, string>} [extraHeaders]
   * @returns {Promise<string>}
   */
  async get(apiPath, extraHeaders = {}) {
    /** @type {Record<string, string>} */
    const headers = {
      "X-Requested-With": "XMLHttpRequest",
      // Firmware literally checks `_ResponseSource: Broswer` (typo in Huawei firmware)
      _ResponseSource: "Broswer",
      Accept: "*/*",
      ...extraHeaders,
    };
    const cookie = this.#cookieHeader();
    if (cookie) headers.Cookie = cookie;

    const res = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.#updateCookies(res.headers);
    const text = await res.text();
    const err = parseXmlError(text);
    if (err) {
      throw new CpeApiError(err.code, `${apiPath}`, err);
    }
    return text;
  }

  async #consumeToken() {
    if (this.tokens.length === 0) {
      const xml = await this.get("/api/webserver/token");
      const fullToken = getXmlTag(xml, "token");
      if (!fullToken || fullToken.length < 32) {
        throw new Error("Failed to acquire CSRF token from /api/webserver/token");
      }
      this.tokens.push(fullToken.slice(32));
    }
    return /** @type {string} */ (this.tokens.shift());
  }

  /**
   * Perform an HTTP POST with automatic CSRF token consumption and rotation.
   *
   * @param {string} apiPath
   * @param {string} body
   * @param {{ clearTokensOnResponse?: boolean }} [opts]
   * @returns {Promise<string>}
   */
  async postRaw(apiPath, body, opts = {}) {
    const token = await this.#consumeToken();
    /** @type {Record<string, string>} */
    const headers = {
      "X-Requested-With": "XMLHttpRequest",
      _ResponseSource: "Broswer",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "*/*",
      __RequestVerificationToken: token,
    };
    const cookie = this.#cookieHeader();
    if (cookie) headers.Cookie = cookie;

    const res = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.#updateCookies(res.headers);
    this.#captureTokens(res.headers, Boolean(opts.clearTokensOnResponse));
    const text = await res.text();
    const err = parseXmlError(text);
    if (err) {
      throw new CpeApiError(err.code, `${apiPath}`, err);
    }
    return text;
  }

  /**
   * Perform an encrypted POST using H168-383 `SoftwareCapability[208]` ECC + AES-256-GCM:
   * - `encType = 1`: plain XML request, AES-GCM encrypted response
   * - `encType = 2`: AES-GCM encrypted request, plain XML response
   * - `encType = 3`: AES-GCM encrypted request AND AES-GCM encrypted response
   *
   * @param {string} apiPath
   * @param {Record<string, unknown>} requestObj
   * @param {1 | 2 | 3} encType
   * @returns {Promise<string>}
   */
  async postEncrypted(apiPath, requestObj, encType) {
    if (!this.ecc) {
      const pubXml = await this.get("/api/webserver/publickey");
      const serverPub = getXmlTag(pubXml, "ecc_server_pubkey");
      if (!serverPub) {
        throw new Error("CPE did not return ecc_server_pubkey");
      }
      this.ecc = generateEccSession(serverPub);
    }

    const plainXml = buildXmlRequest(requestObj);
    const body =
      encType === 1 ? plainXml : aesGcmEncrypt(plainXml, this.ecc.shareKeyHex);
    const sep = apiPath.includes("?") ? "&" : "?";
    const urlWithQuery = `${apiPath}${sep}ecc-client-pubkey=${this.ecc.clientPubHex}&enc-type=${encType}`;

    const rawResponse = await this.postRaw(urlWithQuery, body);
    if (encType === 2) {
      return rawResponse;
    }

    const decryptedXml = aesGcmDecrypt(rawResponse, this.ecc.shareKeyHex);
    const err = parseXmlError(decryptedXml);
    if (err) {
      throw new CpeApiError(err.code, `${apiPath} (decrypted)`, err);
    }
    return decryptedXml;
  }

  /**
   * Authenticate with H168-383 via SCRAM-SHA256 and derive the Curve25519 session key.
   */
  async login() {
    if (!this.password) {
      throw new Error("CPE_PASSWORD 未配置，请在 .env 中设置 CPE 管理密码");
    }

    // Initialize SessionID cookie just like official WebUI (`main_login_store.js` `Q()`)
    await this.get("/api/monitoring/status", { "Update-Cookie": "UpdateCookie" });

    const firstNonce = crypto.randomBytes(32).toString("hex");
    const challengeXml = await this.postRaw(
      "/api/user/challenge_login",
      buildXmlRequest({
        username: escapeXmlBasic(this.username),
        firstnonce: firstNonce,
        mode: 1,
      }),
      { clearTokensOnResponse: true }
    );

    const salt = getXmlTag(challengeXml, "salt");
    const iterationsRaw = getXmlTag(challengeXml, "iterations");
    const serverNonce = getXmlTag(challengeXml, "servernonce");
    if (!salt || !iterationsRaw || !serverNonce) {
      throw new Error("Invalid SCRAM challenge response from CPE");
    }

    const iterations = Number.parseInt(iterationsRaw, 10);
    const scram = computeScram(this.password, salt, iterations, firstNonce, serverNonce);

    const authXml = await this.postRaw(
      "/api/user/authentication_login",
      buildXmlRequest({
        clientproof: scram.clientProofHex,
        finalnonce: serverNonce,
      }),
      { clearTokensOnResponse: true }
    );

    this.loggedIn = true;

    const serverSig = getXmlTag(authXml, "serversignature");
    if (serverSig && serverSig.toLowerCase() !== scram.expectedServerSig.toLowerCase()) {
      throw new Error("SCRAM server signature mismatch (potential MITM)");
    }

    const eccServerPub = getXmlTag(authXml, "ecc_server_pubkey");
    const eccPubSig = getXmlTag(authXml, "ecc_pubkey_signature");
    if (eccServerPub) {
      if (eccPubSig && !verifyPubkeySignature(eccServerPub, scram.serverKey, eccPubSig)) {
        throw new Error("CPE ECC public key signature verification failed");
      }
      this.ecc = generateEccSession(eccServerPub);
    }
  }

  /**
   * Release the CPE's single admin session cleanly so WebUI browser access is never blocked.
   */
  async logout() {
    if (!this.loggedIn) return;
    try {
      await this.postRaw("/api/user/logout", buildXmlRequest({ Logout: 1 }));
    } catch {
      // Ignore logout network/session errors if session already expired
    } finally {
      this.loggedIn = false;
    }
  }
}

/**
 * High-level Huawei 5G CPE Ultra 6 (H168-383) client with serialized short-lived sessions.
 */
export class HuaweiCpeClient {
  /**
   * @param {{
   *   cpeUrl: string,
   *   cpeUsername?: string,
   *   cpePassword: string,
   *   requestTimeoutMs?: number,
   *   fetchImpl?: typeof fetch
   * }} config
   */
  constructor(config) {
    this.baseUrl = config.cpeUrl.replace(/\/+$/, "");
    this.username = config.cpeUsername ?? "admin";
    this.password = config.cpePassword;
    this.timeoutMs = config.requestTimeoutMs ?? 20000;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    /** @type {Promise<unknown>} */
    this.#mutex = Promise.resolve();
  }

  /** @type {Promise<unknown>} */
  #mutex;

  /**
   * Perform an unauthenticated GET request (zero session footprint).
   *
   * @param {string} apiPath
   * @returns {Promise<string>}
   */
  async getPublic(apiPath) {
    const res = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
      method: "GET",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        _ResponseSource: "Broswer",
        Accept: "*/*",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    const err = parseXmlError(text);
    if (err) {
      throw new CpeApiError(err.code, apiPath, err);
    }
    return text;
  }

  /**
   * Unauthenticated notification check (`/api/monitoring/check-notifications`).
   * Works without logging in and never disturbs an open WebUI session in the browser.
   */
  async checkNotifications() {
    const xml = await this.getPublic("/api/monitoring/check-notifications");
    return {
      unreadMessages: Number.parseInt(getXmlTag(xml, "UnreadMessage") ?? "0", 10) || 0,
      smsStorageFull: (getXmlTag(xml, "SmsStorageFull") ?? "0") === "1",
      onlineUpdateStatus: getXmlTag(xml, "OnlineUpdateStatus") ?? "0",
    };
  }

  /**
   * Unauthenticated login state inspection (`/api/user/state-login`).
   */
  async getLoginState() {
    const xml = await this.getPublic("/api/user/state-login");
    return {
      // "0" = someone is currently logged in, "-1" = idle/logged out
      state: getXmlTag(xml, "State") ?? "-1",
      isLoggedInElsewhere: (getXmlTag(xml, "State") ?? "-1") === "0",
      isLocked: (getXmlTag(xml, "lockstatus") ?? "0") === "1",
      remainWaitTime: Number.parseInt(getXmlTag(xml, "remainwaittime") ?? "0", 10) || 0,
      passwordType: getXmlTag(xml, "password_type") ?? "4",
    };
  }

  /**
   * Unauthenticated basic device identity (`/api/device/basic_information`).
   */
  async getBasicDeviceInfo() {
    const xml = await this.getPublic("/api/device/basic_information");
    return {
      deviceName: getXmlTag(xml, "devicename") ?? "Huawei CPE",
      marketingName: getXmlTag(xml, "spreadname_zh") ?? getXmlTag(xml, "spreadname_en") ?? "",
      classify: getXmlTag(xml, "classify") ?? "cpe",
    };
  }

  /**
   * Run an authenticated callback inside a mutex-serialized `login -> fn -> logout` transaction.
   *
   * @template T
   * @param {(session: EphemeralCpeSession) => Promise<T>} fn
   * @param {{ respectBrowserSession?: boolean, retriesOnOccupied?: number }} [options]
   * @returns {Promise<T | null>}
   */
  async withSession(fn, options = {}) {
    const run = async () => {
      const maxAttempts = (options.retriesOnOccupied ?? 2) + 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const loginState = await this.getLoginState();
        if (loginState.isLocked) {
          throw new CpeApiError("108007", `剩余等待时间 ${loginState.remainWaitTime} 分钟`, {
            waitTime: loginState.remainWaitTime,
          });
        }
        if (options.respectBrowserSession && loginState.isLoggedInElsewhere) {
          return null;
        }

        const session = new EphemeralCpeSession({
          baseUrl: this.baseUrl,
          username: this.username,
          password: this.password,
          timeoutMs: this.timeoutMs,
          fetchImpl: this.fetchImpl,
        });

        try {
          await session.login();
          return await fn(session);
        } catch (err) {
          // NEVER retry wrong-password errors so we never trigger CPE lockout!
          if (err instanceof CpeApiError && (err.isAuthWrongPassword || err.isLocked)) {
            throw err;
          }
          if (err instanceof CpeApiError && err.isSessionOccupied && attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 1500 * attempt));
            continue;
          }
          throw err;
        } finally {
          await session.logout();
        }
      }
      return null;
    };

    const next = this.#mutex.then(run, run);
    // Keep mutex chain alive regardless of failure
    this.#mutex = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /**
   * Fetch comprehensive CPE status, signal metrics, and SMS storage counts.
   */
  async getStatusSummary() {
    const [basic, notif] = await Promise.all([
      this.getBasicDeviceInfo(),
      this.checkNotifications(),
    ]);

    const detail = await this.withSession(async (session) => {
      const [smsCountXml, contactCountXml, signalXml, statusXml, plmnXml] = await Promise.all([
        session.get("/api/sms/sms-count"),
        session.get("/api/sms/sms-count-contact").catch(() => ""),
        session.get("/api/device/signal").catch(() => ""),
        session.get("/api/monitoring/status").catch(() => ""),
        session.get("/api/net/current-plmn").catch(() => ""),
      ]);

      return {
        sms: {
          localUnread: Number.parseInt(getXmlTag(smsCountXml, "LocalUnread") ?? "0", 10) || 0,
          localInbox: Number.parseInt(getXmlTag(smsCountXml, "LocalInbox") ?? "0", 10) || 0,
          localOutbox: Number.parseInt(getXmlTag(smsCountXml, "LocalOutbox") ?? "0", 10) || 0,
          localDraft: Number.parseInt(getXmlTag(smsCountXml, "LocalDraft") ?? "0", 10) || 0,
          localMax: Number.parseInt(getXmlTag(smsCountXml, "LocalMax") ?? "500", 10) || 500,
          contactThreads: Number.parseInt(getXmlTag(contactCountXml, "count") ?? "0", 10) || 0,
          storageFull: notif.smsStorageFull,
        },
        signal: {
          mode: getXmlTag(signalXml, "mode") ?? "",
          rsrp: getXmlTag(signalXml, "rsrp") ?? "",
          sinr: getXmlTag(signalXml, "sinr") ?? "",
          nrRsrp: getXmlTag(signalXml, "nr_rsrp") ?? getXmlTag(signalXml, "nrrsrp") ?? "",
          nrSinr: getXmlTag(signalXml, "nr_sinr") ?? getXmlTag(signalXml, "nrsinr") ?? "",
          band: getXmlTag(signalXml, "band") ?? "",
        },
        network: {
          operatorName:
            getXmlTag(plmnXml, "FullName") ??
            getXmlTag(plmnXml, "ShortName") ??
            getXmlTag(plmnXml, "SpnName") ??
            "",
          numericPlmn: getXmlTag(plmnXml, "Numeric") ?? "",
          connectionStatus: getXmlTag(statusXml, "ConnectionStatus") ?? "",
          currentNetworkTypeEx: getXmlTag(statusXml, "CurrentNetworkTypeEx") ?? "",
          signalIcon: getXmlTag(statusXml, "SignalIcon") ?? "",
        },
      };
    });

    return {
      device: basic,
      ...detail,
    };
  }

  /**
   * List SMS contact conversation threads via encrypted `/api/sms/sms-list-contact` (`enc-type=1`).
   *
   * @param {{ page?: number, count?: number }} [opts]
   */
  async listContacts(opts = {}) {
    const page = Math.max(1, opts.page ?? 1);
    const count = Math.min(50, Math.max(1, opts.count ?? 15));

    return await this.withSession(async (session) => {
      const countXml = await session.get("/api/sms/sms-count-contact");
      const total = Number.parseInt(getXmlTag(countXml, "count") ?? "0", 10) || 0;
      if (total === 0) {
        return { total: 0, page, count, contacts: [] };
      }

      const decXml = await session.postEncrypted(
        "/api/sms/sms-list-contact",
        { pageindex: page, readcount: count },
        1
      );
      const contacts = getXmlBlocks(decXml, "message").map(parseSmsMessageBlock);
      return { total, page, count, contacts };
    });
  }

  /**
   * List SMS messages in a conversation with a specific phone/sender via encrypted
   * `/api/sms/sms-list-phone` (`enc-type=3`).
   *
   * @param {string} phone
   * @param {{ page?: number, count?: number }} [opts]
   */
  async listPhoneMessages(phone, opts = {}) {
    const page = Math.max(1, opts.page ?? 1);
    const count = Math.min(50, Math.max(1, opts.count ?? 20));
    const targetPhone = phone.trim();

    return await this.withSession(async (session) => {
      const countXml = await session.postEncrypted(
        "/api/sms/sms-count-contact",
        { phone: huaweiXssEncode(targetPhone) },
        2
      );
      const total = Number.parseInt(getXmlTag(countXml, "count") ?? "0", 10) || 0;
      if (total === 0) {
        return { phone: targetPhone, total: 0, page, count, messages: [] };
      }

      const decXml = await session.postEncrypted(
        "/api/sms/sms-list-phone",
        { phone: escapeXmlBasic(targetPhone), pageindex: page, readcount: count },
        3
      );
      const messages = getXmlBlocks(decXml, "message")
        .map(parseSmsMessageBlock)
        .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : a.index - b.index));

      return { phone: targetPhone, total, page, count, messages };
    });
  }

  /**
   * Fetch recent individual inbox messages (newest first) for accurate notification diffing
   * and `/unread` listing. Uses `/api/sms/sms-list` (`BoxType=1`) and automatically falls back
   * to encrypted `sms-list-contact` + `sms-list-phone` if needed.
   *
   * @param {{ count?: number, unreadOnly?: boolean, respectBrowserSession?: boolean }} [opts]
   */
  async fetchRecentInboxMessages(opts = {}) {
    const readCount = Math.min(50, Math.max(1, opts.count ?? 20));
    const unreadPreferred = opts.unreadOnly ? 1 : 0;

    return await this.withSession(
      async (session) => {
        const smsCountXml = await session.get("/api/sms/sms-count");
        const localUnread = Number.parseInt(getXmlTag(smsCountXml, "LocalUnread") ?? "0", 10) || 0;
        const localInbox = Number.parseInt(getXmlTag(smsCountXml, "LocalInbox") ?? "0", 10) || 0;
        const localMax = Number.parseInt(getXmlTag(smsCountXml, "LocalMax") ?? "500", 10) || 500;

        try {
          const listXml = await session.postRaw(
            "/api/sms/sms-list",
            buildXmlRequest({
              PageIndex: 1,
              ReadCount: readCount,
              BoxType: 1,
              SortType: 0,
              Ascending: 0,
              UnreadPreferred: unreadPreferred,
            })
          );
          let messages = getXmlBlocks(listXml, "Message").map((b) => parseSmsMessageBlock(b, "0"));
          if (opts.unreadOnly) {
            messages = messages.filter((m) => m.isUnread);
          }
          return { localUnread, localInbox, localMax, messages };
        } catch {
          // Fallback to encrypted session-SMS endpoints if a firmware revision removes /api/sms/sms-list
          const decXml = await session.postEncrypted(
            "/api/sms/sms-list-contact",
            { pageindex: 1, readcount: readCount },
            1
          );
          let messages = getXmlBlocks(decXml, "message")
            .map((b) => parseSmsMessageBlock(b))
            .filter((m) => m.direction === "in");
          if (opts.unreadOnly) {
            messages = messages.filter((m) => m.isUnread);
          }
          return { localUnread, localInbox, localMax, messages };
        }
      },
      { respectBrowserSession: Boolean(opts.respectBrowserSession) }
    );
  }

  /**
   * Paginate and fetch ALL historical SMS messages (both LocalInbox and LocalOutbox)
   * inside a single ephemeral session so the Web UI can load 100% of device history.
   *
   * @param {{ respectBrowserSession?: boolean }} [opts]
   */
  async fetchAllMessages(opts = {}) {
    return await this.withSession(
      async (session) => {
        const smsCountXml = await session.get("/api/sms/sms-count");
        const localUnread = Number.parseInt(getXmlTag(smsCountXml, "LocalUnread") ?? "0", 10) || 0;
        const localInbox = Number.parseInt(getXmlTag(smsCountXml, "LocalInbox") ?? "0", 10) || 0;
        const localOutbox = Number.parseInt(getXmlTag(smsCountXml, "LocalOutbox") ?? "0", 10) || 0;
        const localMax = Number.parseInt(getXmlTag(smsCountXml, "LocalMax") ?? "500", 10) || 500;

        /** @type {Array<ReturnType<typeof parseSmsMessageBlock>>} */
        const all = [];
        const pageSize = 50;

        try {
          const inboxPages = Math.ceil(localInbox / pageSize);
          for (let page = 1; page <= inboxPages; page++) {
            const xml = await session.postRaw(
              "/api/sms/sms-list",
              buildXmlRequest({
                PageIndex: page,
                ReadCount: pageSize,
                BoxType: 1,
                SortType: 0,
                Ascending: 0,
                UnreadPreferred: 0,
              })
            );
            const items = getXmlBlocks(xml, "Message").map((b) => parseSmsMessageBlock(b, "0"));
            all.push(...items);
            if (items.length < pageSize) break;
          }

          const outboxPages = Math.ceil(localOutbox / pageSize);
          for (let page = 1; page <= outboxPages; page++) {
            const xml = await session.postRaw(
              "/api/sms/sms-list",
              buildXmlRequest({
                PageIndex: page,
                ReadCount: pageSize,
                BoxType: 2,
                SortType: 0,
                Ascending: 0,
                UnreadPreferred: 0,
              })
            );
            const items = getXmlBlocks(xml, "Message").map((b) => parseSmsMessageBlock(b, "1"));
            all.push(...items);
            if (items.length < pageSize) break;
          }
        } catch {
          // Encrypted session-SMS pagination fallback (`sms-list-contact` + `sms-list-phone`)
          const countContactXml = await session.get("/api/sms/sms-count-contact");
          const totalContacts =
            Number.parseInt(getXmlTag(countContactXml, "count") ?? "0", 10) || 0;
          const contactPages = Math.ceil(totalContacts / 20);
          const phones = new Set();

          for (let p = 1; p <= contactPages; p++) {
            const decContacts = await session.postEncrypted(
              "/api/sms/sms-list-contact",
              { pageindex: p, readcount: 20 },
              1
            );
            for (const b of getXmlBlocks(decContacts, "message")) {
              const ph = getXmlTag(b, "phone");
              if (ph) phones.add(ph);
            }
          }

          for (const ph of phones) {
            const cXml = await session.postEncrypted(
              "/api/sms/sms-count-contact",
              { phone: huaweiXssEncode(ph) },
              2
            );
            const phTotal = Number.parseInt(getXmlTag(cXml, "count") ?? "0", 10) || 0;
            const phPages = Math.ceil(phTotal / 20);
            for (let p = 1; p <= phPages; p++) {
              const decPhone = await session.postEncrypted(
                "/api/sms/sms-list-phone",
                { phone: escapeXmlBasic(ph), pageindex: p, readcount: 20 },
                3
              );
              all.push(...getXmlBlocks(decPhone, "message").map((b) => parseSmsMessageBlock(b)));
            }
          }
        }

        return {
          localUnread,
          localInbox,
          localOutbox,
          localMax,
          messages: all,
        };
      },
      { respectBrowserSession: Boolean(opts.respectBrowserSession) }
    );
  }

  /**
   * Send an SMS via H168-383 encrypted `/api/sms/send-sms` (`enc-type=2`) and poll
   * encrypted `/api/sms/send-status` (`enc-type=1`) until carrier submission finishes.
   *
   * @param {string | string[]} phones
   * @param {string} content
   * @param {{ pollTimeoutMs?: number, pollIntervalMs?: number }} [opts]
   */
  async sendSms(phones, content, opts = {}) {
    const phoneList = (Array.isArray(phones) ? phones : [phones])
      .map(normalizePhone)
      .filter(Boolean);

    if (phoneList.length === 0) {
      throw new Error("接收方号码不能为空");
    }
    for (const p of phoneList) {
      if (!isDialablePhone(p)) {
        throw new Error(`无效或不可回复的号码 "${p}"（仅支持数字或 +国际区号）`);
      }
    }

    const cleanContent = stripInvalidControlChars(content).trim();
    if (!cleanContent) {
      throw new Error("短信内容不能为空");
    }

    const modeInfo = detectSmsTextMode(cleanContent);
    if (modeInfo.segments > 4) {
      throw new Error(
        `短信内容过长（当前占 ${modeInfo.segments} 条分段，CPE 单次最多支持 4 条长短信拼接）`
      );
    }

    const escapedContent = huaweiXssEncode(cleanContent);
    const pollTimeoutMs = opts.pollTimeoutMs ?? 45000;
    const pollIntervalMs = opts.pollIntervalMs ?? 2000;

    return await this.withSession(async (session) => {
      await session.postEncrypted(
        "/api/sms/send-sms",
        {
          Index: -1,
          Phones: {
            Phone: phoneList.map(escapeXmlBasic),
          },
          Sca: "",
          Content: escapedContent,
          Length: escapedContent.length,
          Reserved: modeInfo.textMode,
          Date: formatHuaweiDate(new Date()),
        },
        2
      );

      const deadline = Date.now() + pollTimeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        const statusXml = await session.postEncrypted("/api/sms/send-status", {}, 1);
        const pendingPhone = getXmlTag(statusXml, "Phone") ?? "";
        const sucPhone = getXmlTag(statusXml, "SucPhone") ?? "";
        const failPhone = getXmlTag(statusXml, "FailPhone") ?? "";
        const failCode = getXmlTag(statusXml, "SendFailCode") ?? "";

        if (pendingPhone === "") {
          const sentPhones = sucPhone
            .split(/[,;]/)
            .map((s) => s.trim())
            .filter(Boolean);
          const failedPhones = failPhone
            .split(/[,;]/)
            .map((s) => s.trim())
            .filter(Boolean);
          const ok = failedPhones.length === 0 && (sentPhones.length > 0 || !failCode || failCode === "0");

          return {
            ok,
            submitted: true,
            sentPhones: sentPhones.length > 0 ? sentPhones : ok ? phoneList : [],
            failedPhones,
            failCode: failCode && failCode !== "0" ? failCode : null,
            encoding: modeInfo.encoding,
            segments: modeInfo.segments,
          };
        }
      }

      return {
        ok: true,
        submitted: true,
        timedOutWaitingStatus: true,
        sentPhones: phoneList,
        failedPhones: [],
        failCode: null,
        encoding: modeInfo.encoding,
        segments: modeInfo.segments,
      };
    });
  }

  /**
   * Mark one or more SMS messages as read (`/api/sms/set-read`).
   *
   * @param {Array<number | string>} indices
   */
  async markRead(indices) {
    const clean = [...new Set(indices.map((i) => Number.parseInt(String(i), 10)).filter((n) => n > 0))];
    if (clean.length === 0) return { count: 0 };

    await this.withSession(async (session) => {
      // Huawei firmware accepts up to ~20 <Index> tags per set-read call
      for (let i = 0; i < clean.length; i += 20) {
        const batch = clean.slice(i, i + 20);
        await session.postRaw("/api/sms/set-read", buildXmlRequest({ Index: batch }));
      }
    });
    return { count: clean.length };
  }

  /**
   * Delete one or more SMS messages by index (`/api/sms/delete-sms`).
   *
   * @param {Array<number | string>} indices
   */
  async deleteSms(indices) {
    const clean = [...new Set(indices.map((i) => Number.parseInt(String(i), 10)).filter((n) => n > 0))];
    if (clean.length === 0) return { count: 0 };

    await this.withSession(async (session) => {
      for (let i = 0; i < clean.length; i += 20) {
        const batch = clean.slice(i, i + 20);
        await session.postRaw("/api/sms/delete-sms", buildXmlRequest({ Index: batch }));
      }
    });
    return { count: clean.length };
  }

  /**
   * Delete entire conversation threads by phone/sender (`/api/sms/sms-delete-phone`, `enc-type=2`).
   *
   * @param {string[]} phones
   */
  async deleteContacts(phones) {
    const clean = phones.map((p) => p.trim()).filter(Boolean);
    if (clean.length === 0) return { count: 0 };

    await this.withSession(async (session) => {
      await session.postEncrypted(
        "/api/sms/sms-delete-phone",
        { Phones: { Phone: clean.map(escapeXmlBasic) } },
        2
      );
    });
    return { count: clean.length };
  }
}
