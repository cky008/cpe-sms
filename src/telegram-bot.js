import crypto from "node:crypto";
import { extractVerificationCode } from "./crypto.js";
import { isDialablePhone } from "./cpe-client.js";

/**
 * Escape text for Telegram `parse_mode: "HTML"`.
 *
 * @param {string | number} text
 * @returns {string}
 */
export function escapeTelegramHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Timing-safe string equality check for `/auth` password verification.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqualString(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Build a safe `callback_data` string within Telegram's 64-byte limit.
 *
 * @param {string} prefix
 * @param {string | number} arg
 * @returns {string | null}
 */
function makeCallbackData(prefix, arg) {
  const full = `${prefix}:${arg}`;
  return Buffer.byteLength(full, "utf8") <= 64 ? full : null;
}

/**
 * Bidirectional Telegram Bot for H168-383 CPE SMS management & real-time push notifications.
 */
export class TelegramSmsBot {
  /**
   * @param {{
   *   token: string,
   *   apiBase?: string,
   *   allowedChatIds?: string[],
   *   cpePassword: string,
   *   cpeClient: import("./cpe-client.js").HuaweiCpeClient,
   *   stateStore: import("./state-store.js").StateStore,
   *   poller?: import("./poller.js").SmsPoller,
   *   fetchImpl?: typeof fetch
   * }} opts
   */
  constructor(opts) {
    this.token = opts.token;
    this.apiBase = (opts.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.allowedChatIds = (opts.allowedChatIds ?? []).map(String);
    this.cpePassword = opts.cpePassword;
    this.cpeClient = opts.cpeClient;
    this.stateStore = opts.stateStore;
    this.poller = opts.poller ?? null;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;

    this.botInfo = null;
    this.#running = false;
    this.#offset = 0;
    /** @type {AbortController | null} */
    this.#pollAbort = null;
    /** @type {Map<string, { count: number, resetAt: number }>} */
    this.#failedAuthAttempts = new Map();
  }

  #running;
  #offset;
  #pollAbort;
  #failedAuthAttempts;

  /**
   * Call a Telegram Bot API method.
   *
   * @param {string} method
   * @param {Record<string, unknown>} [payload]
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
   */
  async callApi(method, payload = {}, opts = {}) {
    const url = `${this.apiBase}/bot${this.token}/${method}`;
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 20000);
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : timeoutSignal;

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal,
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Telegram API ${method} failed (${data.error_code}): ${data.description}`);
    }
    return data.result;
  }

  /**
   * Start Telegram Bot command registration and long-polling loop.
   */
  async start() {
    if (!this.token || this.#running) return;
    this.botInfo = await this.callApi("getMe");
    await this.callApi("setMyCommands", {
      commands: [
        { command: "inbox", description: "查看最近短信会话列表" },
        { command: "unread", description: "查看未读短信" },
        { command: "send", description: "发送短信: /send 号码 内容" },
        { command: "chat", description: "查看与某号码的对话: /chat 号码" },
        { command: "status", description: "查看 5G 信号与短信容量状态" },
        { command: "sync", description: "立即同步检查新短信" },
        { command: "help", description: "使用说明与快捷菜单" },
      ],
    }).catch(() => {});

    this.#running = true;
    this.#pollLoop();
  }

  stop() {
    this.#running = false;
    if (this.#pollAbort) {
      this.#pollAbort.abort();
      this.#pollAbort = null;
    }
  }

  async #pollLoop() {
    let backoffMs = 1500;
    while (this.#running) {
      this.#pollAbort = new AbortController();
      try {
        const updates = await this.callApi(
          "getUpdates",
          {
            offset: this.#offset,
            timeout: 25,
            allowed_updates: ["message", "callback_query"],
          },
          { timeoutMs: 35000, signal: this.#pollAbort.signal }
        );
        backoffMs = 1500;
        for (const update of updates) {
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          this.#handleUpdate(update).catch((err) => {
            console.error("[TelegramBot] Update handler error:", err.message);
          });
        }
      } catch (err) {
        if (!this.#running) break;
        if (err.name === "AbortError") continue;
        console.warn(`[TelegramBot] Poll error (${err.message}), retrying in ${backoffMs}ms...`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(30000, backoffMs * 2);
      }
    }
  }

  /**
   * Push a newly arrived SMS notification to all authorized Telegram chats.
   *
   * @param {ReturnType<import("./cpe-client.js").parseSmsMessageBlock> & { verificationCode?: string | null }} sms
   */
  async notifyNewSms(sms) {
    const targets = this.stateStore.getAllAuthorizedChats(this.allowedChatIds);
    if (targets.length === 0) {
      console.warn(
        `[TelegramBot] 收到来自 ${sms.phone} 的新短信 (#${sms.index})，但尚未绑定授权 Telegram 会话。请在 Telegram 向 @${this.botInfo?.username ?? "bot"} 发送 /start 完成绑定。`
      );
      return;
    }

    const otp = sms.verificationCode ?? extractVerificationCode(sms.content);
    const lines = [
      `📩 <b>收到新短信</b>`,
      `📞 <b>发件人：</b><code>${escapeTelegramHtml(sms.phone || "未知")}</code>`,
      `🕒 <b>时间：</b>${escapeTelegramHtml(sms.date)}`,
    ];
    if (otp) {
      lines.push(`🔑 <b>验证码：</b><code>${escapeTelegramHtml(otp)}</code> <i>(点击复制)</i>`);
    }
    lines.push("", escapeTelegramHtml(sms.content.slice(0, 3400)));
    if (sms.content.length > 3400) {
      lines.push("<i>...(内容过长已截断)</i>");
    }
    if (isDialablePhone(sms.phone)) {
      lines.push("", `💡 <i>直接「回复」本条消息即可发短信给 ${escapeTelegramHtml(sms.phone)}</i>`);
    }

    /** @type {Array<Array<{ text: string, callback_data: string }>>} */
    const row = [];
    const readCb = makeCallbackData("read", sms.index);
    const chatCb = makeCallbackData("chat", sms.phone);
    const delCb = makeCallbackData("del", sms.index);
    if (sms.isUnread && readCb) row.push({ text: "✅ 设为已读", callback_data: readCb });
    if (chatCb) row.push({ text: "💬 查看对话", callback_data: chatCb });
    if (delCb) row.push({ text: "🗑 删除", callback_data: delCb });

    for (const chatId of targets) {
      try {
        const sent = await this.callApi("sendMessage", {
          chat_id: chatId,
          text: lines.join("\n"),
          parse_mode: "HTML",
          reply_markup: row.length > 0 ? { inline_keyboard: [row] } : undefined,
        });
        if (sent?.message_id && sms.phone) {
          this.stateStore.bindReplyTarget(chatId, sent.message_id, sms.phone);
        }
      } catch (err) {
        console.error(`[TelegramBot] Failed to notify chat ${chatId}:`, err.message);
      }
    }
  }

  /**
   * Push storage capacity alert to authorized chats.
   *
   * @param {{ localInbox: number, localMax: number, storageFull: boolean }} info
   */
  async notifyStorageWarning(info) {
    const targets = this.stateStore.getAllAuthorizedChats(this.allowedChatIds);
    const title = info.storageFull ? "🚨 <b>CPE 短信存储已满！</b>" : "⚠️ <b>CPE 短信存储即将占满</b>";
    const text = [
      title,
      `当前收件箱容量：<b>${info.localInbox} / ${info.localMax}</b>`,
      `存储满后 CPE 将无法接收新短信，请及时清理旧短信。`,
    ].join("\n");

    for (const chatId of targets) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }).catch(() => {});
    }
  }

  /**
   * @param {any} update
   */
  async #handleUpdate(update) {
    if (update.callback_query) {
      await this.#handleCallbackQuery(update.callback_query);
      return;
    }
    if (update.message) {
      await this.#handleMessage(update.message);
    }
  }

  /**
   * Check rate-limited `/auth` attempts per chat.
   *
   * @param {string} chatId
   * @returns {boolean}
   */
  #isAuthRateLimited(chatId) {
    const entry = this.#failedAuthAttempts.get(chatId);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      this.#failedAuthAttempts.delete(chatId);
      return false;
    }
    return entry.count >= 5;
  }

  #recordFailedAuth(chatId) {
    const now = Date.now();
    const cur = this.#failedAuthAttempts.get(chatId);
    if (!cur || now > cur.resetAt) {
      this.#failedAuthAttempts.set(chatId, { count: 1, resetAt: now + 10 * 60 * 1000 });
    } else {
      cur.count += 1;
    }
  }

  /**
   * @param {any} msg
   */
  async #handleMessage(msg) {
    const chatId = String(msg.chat?.id ?? "");
    if (!chatId) return;
    const text = (msg.text ?? "").trim();
    if (!text) return;

    const authorized = this.stateStore.isChatAuthorized(chatId, this.allowedChatIds);

    // Handle `/auth <password>` even before authorization
    if (/^\/auth(?:@\S+)?(?:\s+|$)/i.test(text)) {
      const arg = text.replace(/^\/auth(?:@\S+)?\s*/i, "");
      // Best-effort delete the password message from chat history for privacy
      if (msg.message_id) {
        this.callApi("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(
          () => {}
        );
      }

      if (authorized) {
        await this.#sendHtml(chatId, `✅ 当前会话 (<code>${chatId}</code>) 已授权，无需重复验证。`);
        return;
      }
      if (this.#isAuthRateLimited(chatId)) {
        await this.#sendHtml(chatId, `⛔ 验证失败次数过多，请 10 分钟后再试。`);
        return;
      }
      if (!arg) {
        await this.#sendHtml(chatId, `用法：<code>/auth 你的CPE登录密码</code>`);
        return;
      }
      if (safeEqualString(arg, this.cpePassword)) {
        this.stateStore.authorizeChat(chatId);
        this.#failedAuthAttempts.delete(chatId);
        await this.#sendHtml(
          chatId,
          [
            `🎉 <b>绑定授权成功！</b>`,
            `已授权 Chat ID：<code>${chatId}</code>（密码消息已自动撤回保护隐私）`,
            `从此以后 CPE 收到的所有新短信都会实时推送到这里。`,
          ].join("\n")
        );
        await this.#cmdStatus(chatId);
      } else {
        this.#recordFailedAuth(chatId);
        await this.#sendHtml(chatId, `❌ CPE 密码不正确，请检查后重试。`);
      }
      return;
    }

    if (!authorized) {
      await this.#sendHtml(
        chatId,
        [
          `🔐 <b>H168-383 CPE 短信网关</b>`,
          `当前会话尚未授权（Chat ID: <code>${escapeTelegramHtml(chatId)}</code>）。`,
          ``,
          `请发送以下命令完成安全绑定：`,
          `<code>/auth 你的CPE管理界面密码</code>`,
          ``,
          `<i>提示：验证成功后包含密码的消息会自动删除；你也可以将该 Chat ID 写入 .env 的 TELEGRAM_CHAT_IDS。</i>`,
        ].join("\n")
      );
      return;
    }

    // Native Reply-to-Message -> Send SMS directly!
    if (!text.startsWith("/") && msg.reply_to_message?.message_id) {
      const targetPhone = this.stateStore.getReplyTarget(chatId, msg.reply_to_message.message_id);
      if (targetPhone) {
        if (!isDialablePhone(targetPhone)) {
          await this.#sendHtml(
            chatId,
            `⚠️ 发件人 <code>${escapeTelegramHtml(targetPhone)}</code> 为字母服务号，不支持直接回复短信。`
          );
          return;
        }
        await this.#executeSendSms(chatId, targetPhone, text);
        return;
      }
    }

    const cmdMatch = text.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
    if (!cmdMatch) {
      await this.#sendHtml(
        chatId,
        `💡 发送短信请使用 <code>/send 号码 内容</code>，或直接<b>回复</b>任意一条短信通知卡片。输入 /help 查看全部命令。`
      );
      return;
    }

    const cmd = cmdMatch[1].toLowerCase();
    const rest = (cmdMatch[2] ?? "").trim();

    switch (cmd) {
      case "start":
      case "help":
        await this.#cmdHelp(chatId);
        break;
      case "status":
        await this.#cmdStatus(chatId);
        break;
      case "inbox":
      case "sms":
        await this.#cmdInbox(chatId, Number.parseInt(rest || "1", 10) || 1);
        break;
      case "unread":
        await this.#cmdUnread(chatId);
        break;
      case "chat":
      case "thread":
        await this.#cmdChat(chatId, rest);
        break;
      case "send":
        await this.#cmdSend(chatId, rest);
        break;
      case "read":
        await this.#cmdRead(chatId, rest);
        break;
      case "delete":
      case "del":
        await this.#cmdDelete(chatId, rest);
        break;
      case "sync":
        await this.#cmdSync(chatId);
        break;
      default:
        await this.#sendHtml(chatId, `未知命令 <code>/${escapeTelegramHtml(cmd)}</code>，请发送 /help 查看说明。`);
    }
  }

  /**
   * @param {any} cq
   */
  async #handleCallbackQuery(cq) {
    const chatId = String(cq.message?.chat?.id ?? "");
    const data = String(cq.data ?? "");
    if (!chatId || !this.stateStore.isChatAuthorized(chatId, this.allowedChatIds)) {
      await this.callApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "未授权会话",
        show_alert: true,
      }).catch(() => {});
      return;
    }

    const colon = data.indexOf(":");
    const action = colon >= 0 ? data.slice(0, colon) : data;
    const arg = colon >= 0 ? data.slice(colon + 1) : "";

    try {
      if (action === "read") {
        await this.cpeClient.markRead([arg]);
        await this.callApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `✅ 短信 #${arg} 已设为已读`,
        });
      } else if (action === "readall") {
        const inbox = await this.cpeClient.fetchRecentInboxMessages({ count: 50, unreadOnly: true });
        const ids = (inbox?.messages ?? []).map((m) => m.index);
        if (ids.length > 0) await this.cpeClient.markRead(ids);
        await this.callApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: ids.length > 0 ? `✅ 已将 ${ids.length} 条短信设为已读` : "当前没有未读短信",
        });
      } else if (action === "del") {
        await this.cpeClient.deleteSms([arg]);
        await this.callApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `🗑 已删除短信 #${arg}`,
        });
      } else if (action === "chat") {
        await this.callApi("answerCallbackQuery", { callback_query_id: cq.id });
        await this.#cmdChat(chatId, arg);
      } else if (action === "inbox") {
        await this.callApi("answerCallbackQuery", { callback_query_id: cq.id });
        await this.#cmdInbox(chatId, Number.parseInt(arg || "1", 10) || 1);
      } else if (action === "unread") {
        await this.callApi("answerCallbackQuery", { callback_query_id: cq.id });
        await this.#cmdUnread(chatId);
      } else if (action === "status") {
        await this.callApi("answerCallbackQuery", { callback_query_id: cq.id });
        await this.#cmdStatus(chatId);
      } else {
        await this.callApi("answerCallbackQuery", { callback_query_id: cq.id });
      }
    } catch (err) {
      await this.callApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `操作失败: ${err.message.slice(0, 120)}`,
        show_alert: true,
      }).catch(() => {});
    }
  }

  /**
   * @param {string} chatId
   * @param {string} html
   * @param {Record<string, unknown>} [extra]
   */
  async #sendHtml(chatId, html, extra = {}) {
    return await this.callApi("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      ...extra,
    });
  }

  async #cmdHelp(chatId) {
    const html = [
      `📡 <b>华为 5G CPE Ultra 6 (H168-383) 短信助手</b>`,
      ``,
      `<b>常用指令：</b>`,
      `• /inbox — 查看最近短信联系人会话`,
      `• /unread — 查看最近未读短信`,
      `• /chat <code>号码</code> — 查看与该号码的完整往来记录`,
      `• /send <code>号码 短信内容</code> — 发送短信并追踪送达状态`,
      `• /read <code>短信ID 或 all</code> — 标记已读`,
      `• /delete <code>短信ID</code> — 删除指定短信`,
      `• /status — 查看 5G/4G 信号与短信容量`,
      `• /sync — 立即同步检查收件箱`,
      ``,
      `💡 <b>快捷回复技巧：</b>直接长按/右键「回复」任意短信通知或对话卡片，输入文字即可直接回复给对方号码！`,
    ].join("\n");

    await this.#sendHtml(chatId, html, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📬 最近会话", callback_data: "inbox:1" },
            { text: "🔴 未读短信", callback_data: "unread:1" },
            { text: "📶 设备状态", callback_data: "status:1" },
          ],
        ],
      },
    });
  }

  async #cmdStatus(chatId) {
    try {
      const s = await this.cpeClient.getStatusSummary();
      const lines = [
        `📡 <b>${escapeTelegramHtml(s.device.marketingName || s.device.deviceName)} (${escapeTelegramHtml(s.device.deviceName)})</b>`,
        `🔗 <b>地址：</b><code>${escapeTelegramHtml(this.cpeClient.baseUrl)}</code>`,
      ];
      if (s.network?.operatorName || s.network?.numericPlmn) {
        lines.push(
          `🌐 <b>运营商：</b>${escapeTelegramHtml(s.network.operatorName || s.network.numericPlmn)}`
        );
      }
      if (s.signal) {
        const sigParts = [];
        if (s.signal.nrRsrp) sigParts.push(`5G RSRP ${s.signal.nrRsrp} / SINR ${s.signal.nrSinr || "-"}`);
        if (s.signal.rsrp) sigParts.push(`4G RSRP ${s.signal.rsrp} / SINR ${s.signal.sinr || "-"}`);
        if (sigParts.length > 0) {
          lines.push(`📶 <b>信号：</b>${escapeTelegramHtml(sigParts.join(" | "))}`);
        }
      }
      if (s.sms) {
        lines.push(
          `✉️ <b>未读短信：</b><b>${s.sms.localUnread}</b> 条`,
          `🗂 <b>存储占用：</b>收件箱 ${s.sms.localInbox} / 容量 ${s.sms.localMax}（发件箱 ${s.sms.localOutbox}，会话 ${s.sms.contactThreads} 个）`
        );
      }
      await this.#sendHtml(chatId, lines.join("\n"), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📬 查看收件箱", callback_data: "inbox:1" },
              { text: "🔴 查看未读", callback_data: "unread:1" },
            ],
          ],
        },
      });
    } catch (err) {
      await this.#sendHtml(chatId, `❌ 获取状态失败：${escapeTelegramHtml(err.message)}`);
    }
  }

  async #cmdInbox(chatId, page = 1) {
    try {
      const pageSize = 8;
      const res = await this.cpeClient.listContacts({ page, count: pageSize });
      if (!res || res.contacts.length === 0) {
        await this.#sendHtml(chatId, `📭 当前没有短信会话。`);
        return;
      }

      const totalPages = Math.max(1, Math.ceil(res.total / pageSize));
      const lines = [`📬 <b>最近短信会话（第 ${page}/${totalPages} 页，共 ${res.total} 个联系人）</b>`, ""];

      /** @type {Array<Array<{ text: string, callback_data: string }>>} */
      const keyboard = [];
      let currentRow = [];

      for (const c of res.contacts) {
        const badge = c.isUnread ? "🔴" : c.direction === "out" ? "📤" : "⚪";
        const preview = c.content.replace(/\s+/g, " ").slice(0, 48);
        lines.push(
          `${badge} <b>${escapeTelegramHtml(c.phone)}</b> <i>(${escapeTelegramHtml(c.date)})</i>\n` +
            `└ ${escapeTelegramHtml(preview)}${c.content.length > 48 ? "…" : ""}`
        );

        const cb = makeCallbackData("chat", c.phone);
        if (cb) {
          currentRow.push({ text: `💬 ${c.phone.slice(0, 14)}`, callback_data: cb });
          if (currentRow.length === 2) {
            keyboard.push(currentRow);
            currentRow = [];
          }
        }
      }
      if (currentRow.length > 0) keyboard.push(currentRow);

      const navRow = [];
      if (page > 1) navRow.push({ text: "⬅️ 上一页", callback_data: `inbox:${page - 1}` });
      if (page < totalPages) navRow.push({ text: "➡️ 下一页", callback_data: `inbox:${page + 1}` });
      if (navRow.length > 0) keyboard.push(navRow);

      await this.#sendHtml(chatId, lines.join("\n"), {
        reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
      });
    } catch (err) {
      await this.#sendHtml(chatId, `❌ 读取会话列表失败：${escapeTelegramHtml(err.message)}`);
    }
  }

  async #cmdUnread(chatId) {
    try {
      const res = await this.cpeClient.fetchRecentInboxMessages({ count: 10, unreadOnly: true });
      if (!res || res.messages.length === 0) {
        await this.#sendHtml(chatId, `✅ 当前没有未读短信。`);
        return;
      }

      const lines = [
        `🔴 <b>未读短信（展示最近 ${res.messages.length} / 共 ${res.localUnread} 条未读）</b>`,
        "",
      ];
      for (const m of res.messages) {
        const otp = extractVerificationCode(m.content);
        const otpBadge = otp ? ` [🔑 <code>${escapeTelegramHtml(otp)}</code>]` : "";
        lines.push(
          `• <b>#${m.index}</b> <code>${escapeTelegramHtml(m.phone)}</code> (${escapeTelegramHtml(m.date)})${otpBadge}\n` +
            `  ${escapeTelegramHtml(m.content.replace(/\s+/g, " ").slice(0, 120))}${m.content.length > 120 ? "…" : ""}`
        );
      }

      await this.#sendHtml(chatId, lines.join("\n"), {
        reply_markup: {
          inline_keyboard: [[{ text: "✅ 将最近未读设为已读", callback_data: "readall:1" }]],
        },
      });
    } catch (err) {
      await this.#sendHtml(chatId, `❌ 获取未读短信失败：${escapeTelegramHtml(err.message)}`);
    }
  }

  async #cmdChat(chatId, phoneArg) {
    const phone = phoneArg.trim();
    if (!phone) {
      await this.#sendHtml(chatId, `用法：<code>/chat 号码或发件人</code>（例如 <code>/chat 10086</code>）`);
      return;
    }

    try {
      const res = await this.cpeClient.listPhoneMessages(phone, { page: 1, count: 12 });
      if (!res || res.messages.length === 0) {
        await this.#sendHtml(chatId, `📭 未找到与 <code>${escapeTelegramHtml(phone)}</code> 的短信记录。`);
        return;
      }

      const lines = [`💬 <b>与 <code>${escapeTelegramHtml(phone)}</code> 的对话（共 ${res.total} 条）</b>`, ""];
      const recent = res.messages.slice(-10);
      for (const m of recent) {
        const arrow = m.direction === "out" ? "📤 <b>我</b>" : `📥 <b>${escapeTelegramHtml(phone)}</b>`;
        const unreadDot = m.isUnread ? " 🔴" : "";
        lines.push(`${arrow} <i>(${escapeTelegramHtml(m.date)} #${m.index})</i>${unreadDot}`);
        lines.push(escapeTelegramHtml(m.content.slice(0, 300)));
        lines.push("");
      }

      if (isDialablePhone(phone)) {
        lines.push(`💡 <i>直接「回复」本条消息即可发送短信至 ${escapeTelegramHtml(phone)}</i>`);
      }

      const sent = await this.#sendHtml(chatId, lines.join("\n").slice(0, 4000));
      if (sent?.message_id) {
        this.stateStore.bindReplyTarget(chatId, sent.message_id, phone);
      }
    } catch (err) {
      await this.#sendHtml(chatId, `❌ 读取对话失败：${escapeTelegramHtml(err.message)}`);
    }
  }

  async #cmdSend(chatId, rest) {
    const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
    if (!match) {
      await this.#sendHtml(
        chatId,
        `用法：<code>/send 接收号码 短信内容</code>\n示例：<code>/send 10086 CXLL</code>`
      );
      return;
    }
    await this.#executeSendSms(chatId, match[1], match[2]);
  }

  /**
   * @param {string} chatId
   * @param {string} phone
   * @param {string} content
   */
  async #executeSendSms(chatId, phone, content) {
    const pending = await this.#sendHtml(
      chatId,
      `📤 正在通过 CPE 发送短信至 <code>${escapeTelegramHtml(phone)}</code>…`
    );

    try {
      const result = await this.cpeClient.sendSms(phone, content);
      const resultText = result.ok
        ? [
            `✅ <b>短信发送成功</b>`,
            `📞 <b>收件人：</b><code>${escapeTelegramHtml(phone)}</code>`,
            `📊 <b>编码/分段：</b>${result.encoding} (${result.segments} 条)`,
            ``,
            escapeTelegramHtml(content.slice(0, 1000)),
          ].join("\n")
        : [
            `❌ <b>短信发送失败</b>`,
            `📞 <b>收件人：</b><code>${escapeTelegramHtml(phone)}</code>`,
            result.failCode ? `⚠️ <b>错误码：</b><code>${escapeTelegramHtml(result.failCode)}</code>` : "",
          ]
            .filter(Boolean)
            .join("\n");

      if (pending?.message_id) {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: pending.message_id,
          text: resultText,
          parse_mode: "HTML",
        });
        this.stateStore.bindReplyTarget(chatId, pending.message_id, phone);
      } else {
        await this.#sendHtml(chatId, resultText);
      }
    } catch (err) {
      const errHtml = `❌ <b>发送失败：</b>${escapeTelegramHtml(err.message)}`;
      if (pending?.message_id) {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: pending.message_id,
          text: errHtml,
          parse_mode: "HTML",
        }).catch(() => this.#sendHtml(chatId, errHtml));
      } else {
        await this.#sendHtml(chatId, errHtml);
      }
    }
  }

  async #cmdRead(chatId, arg) {
    if (!arg) {
      await this.#sendHtml(chatId, `用法：<code>/read 短信ID</code> 或 <code>/read all</code>`);
      return;
    }
    try {
      if (arg.toLowerCase() === "all") {
        const res = await this.cpeClient.fetchRecentInboxMessages({ count: 50, unreadOnly: true });
        const ids = (res?.messages ?? []).map((m) => m.index);
        if (ids.length === 0) {
          await this.#sendHtml(chatId, `✅ 当前没有未读短信。`);
          return;
        }
        await this.cpeClient.markRead(ids);
        await this.#sendHtml(chatId, `✅ 已将 ${ids.length} 条未读短信设为已读。`);
      } else {
        const ids = arg.split(/[\s,]+/).filter(Boolean);
        const r = await this.cpeClient.markRead(ids);
        await this.#sendHtml(chatId, `✅ 已标记 ${r.count} 条短信为已读。`);
      }
    } catch (err) {
      await this.#sendHtml(chatId, `❌ 操作失败：${escapeTelegramHtml(err.message)}`);
    }
  }

  async #cmdDelete(chatId, arg) {
    if (!arg) {
      await this.#sendHtml(chatId, `用法：<code>/delete 短信ID</code>（例如 <code>/delete 40182</code>）`);
      return;
    }
    try {
      const ids = arg.split(/[\s,]+/).filter(Boolean);
      const r = await this.cpeClient.deleteSms(ids);
      await this.#sendHtml(chatId, `🗑 已删除 ${r.count} 条短信。`);
    } catch (err) {
      await this.#sendHtml(chatId, `❌ 删除失败：${escapeTelegramHtml(err.message)}`);
    }
  }

  async #cmdSync(chatId) {
    try {
      if (this.poller) {
        const found = await this.poller.syncOnce({ respectBrowserSession: false });
        await this.#sendHtml(
          chatId,
          found.length > 0
            ? `🔄 同步完成，发现并推送了 ${found.length} 条新短信。`
            : `🔄 同步完成，暂无新短信。`
        );
      } else {
        await this.#cmdUnread(chatId);
      }
    } catch (err) {
      await this.#sendHtml(chatId, `❌ 同步失败：${escapeTelegramHtml(err.message)}`);
    }
  }
}
