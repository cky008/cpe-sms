import crypto from "node:crypto";
import type { ContactStore } from "./contacts.ts";
import { type HuaweiCpeClient, isDialablePhone } from "./cpe-client.ts";
import { detectSmsTextMode, extractVerificationCode } from "./crypto.ts";
import { getCountryByDialCode, parseSenderInfo, resolveRecipientPhone } from "./phone.ts";
import type { SmsPoller } from "./poller.ts";
import type { SmsArchiveStore } from "./sms-archive.ts";
import type { StateStore } from "./state-store.ts";
import type { ContactRecord, SenderInfo, SmsMessage } from "./types.ts";
import { formatHuaweiDate } from "./xml.ts";

export function escapeTelegramHtml(text: string | number): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeEqualString(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function makeCallbackData(prefix: string, arg: string | number): string | null {
  const full = `${prefix}:${arg}`;
  return Buffer.byteLength(full, "utf8") <= 64 ? full : null;
}

const WIZARD_QUICK_COUNTRIES = [
  { code: "+353", label: "爱尔兰 +353" },
  { code: "+86", label: "中国 +86" },
  { code: "+44", label: "英国 +44" },
  { code: "+1", label: "美加 +1" },
  { code: "+852", label: "香港 +852" },
] as const;

const WIZARD_TTL_MS = 15 * 60 * 1000;

interface WizardSession {
  step: "awaiting_phone" | "awaiting_content" | "awaiting_confirm";
  countryCode: string;
  phone?: string;
  phoneLabel?: string;
  content?: string;
  expiresAt: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    chat?: { id?: number | string };
    text?: string;
    reply_to_message?: { message_id?: number };
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
    };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id?: number;
      chat?: { id?: number | string };
    };
  };
}

export interface TelegramSmsBotOptions {
  token: string;
  apiBase?: string;
  allowedChatIds?: string[];
  defaultCountryCode?: string;
  cpePassword: string;
  cpeClient: HuaweiCpeClient;
  stateStore: StateStore;
  contactStore?: ContactStore;
  archiveStore?: SmsArchiveStore;
  poller?: SmsPoller;
  fetchImpl?: typeof fetch;
}

export class TelegramSmsBot {
  readonly token: string;
  readonly apiBase: string;
  readonly allowedChatIds: string[];
  readonly defaultCountryCode: string;
  readonly cpePassword: string;
  readonly cpeClient: HuaweiCpeClient;
  readonly stateStore: StateStore;
  readonly contactStore: ContactStore | null;
  readonly archiveStore: SmsArchiveStore | null;
  readonly poller: SmsPoller | null;
  readonly fetchImpl: typeof fetch;

  botInfo: { id?: number; username?: string } | null;

  #running: boolean;
  #offset: number;
  #pollAbort: AbortController | null;
  #failedAuthAttempts: Map<string, { count: number; resetAt: number }>;
  #wizards: Map<string, WizardSession>;

  constructor(opts: TelegramSmsBotOptions) {
    this.token = opts.token;
    this.apiBase = (opts.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.allowedChatIds = (opts.allowedChatIds ?? []).map(String);
    this.defaultCountryCode = opts.defaultCountryCode ?? "+353";
    this.cpePassword = opts.cpePassword;
    this.cpeClient = opts.cpeClient;
    this.stateStore = opts.stateStore;
    this.contactStore = opts.contactStore ?? null;
    this.archiveStore = opts.archiveStore ?? null;
    this.poller = opts.poller ?? null;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;

    this.botInfo = null;
    this.#running = false;
    this.#offset = 0;
    this.#pollAbort = null;
    this.#failedAuthAttempts = new Map();
    this.#wizards = new Map();
  }

  async callApi<T = Record<string, unknown>>(
    method: string,
    payload: Record<string, unknown> = {},
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<T> {
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

    const data = (await res.json()) as {
      ok: boolean;
      result: T;
      error_code?: number;
      description?: string;
    };
    if (!data.ok) {
      throw new Error(
        `Telegram API ${method} failed (${data.error_code ?? res.status}): ${data.description ?? ""}`
      );
    }
    return data.result;
  }

  async downloadTelegramFileText(fileId: string): Promise<string> {
    const fileMeta = await this.callApi<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!fileMeta?.file_path) {
      throw new Error("无法获取 Telegram 文件路径");
    }
    const url = `${this.apiBase}/file/bot${this.token}/${fileMeta.file_path}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      throw new Error(`下载文件失败 (HTTP ${res.status})`);
    }
    return await res.text();
  }

  formatSenderSummary(
    rawPhone: string,
    smsContent = ""
  ): {
    sender: SenderInfo;
    contact: ContactRecord | null;
    whoLine: string;
    phoneLine: string;
    shortTitle: string;
  } {
    const sender = parseSenderInfo(rawPhone, smsContent, this.defaultCountryCode);
    const contact = this.contactStore?.resolvePhone(rawPhone) ?? null;

    const countryBadge = sender.countryCode
      ? `<b>${escapeTelegramHtml(sender.countryZh)} (${escapeTelegramHtml(sender.countryCode)})</b>`
      : `<b>${escapeTelegramHtml(sender.countryZh)}</b>`;

    const numberCode = `<code>${escapeTelegramHtml(sender.e164 ?? (rawPhone || "未知"))}</code>`;
    const rawSuffix =
      sender.e164 && rawPhone && sender.e164 !== rawPhone
        ? ` <i>(原号: ${escapeTelegramHtml(rawPhone)})</i>`
        : "";

    let whoLine = "";
    if (contact) {
      whoLine = `<b>联系人：</b><b>${escapeTelegramHtml(contact.name)}</b>${contact.note ? ` <i>(${escapeTelegramHtml(contact.note)})</i>` : ""}`;
    } else if (sender.brandHint && sender.type !== "alphanumeric") {
      whoLine = `<b>识别来源：</b><b>${escapeTelegramHtml(sender.brandHint)}</b>`;
    }

    return {
      sender,
      contact,
      whoLine,
      phoneLine: `<b>号码：</b>${countryBadge} · ${numberCode}${rawSuffix}`,
      shortTitle: contact
        ? `${escapeTelegramHtml(contact.name)} · ${escapeTelegramHtml(sender.e164 ?? rawPhone)}`
        : sender.brandHint && sender.type !== "alphanumeric"
          ? `${escapeTelegramHtml(sender.e164 ?? rawPhone)} · ${escapeTelegramHtml(sender.brandHint)}`
          : `${escapeTelegramHtml(sender.e164 ?? rawPhone)} · ${escapeTelegramHtml(sender.countryZh)}`,
    };
  }

  async start(): Promise<void> {
    if (!this.token || this.#running) return;
    this.botInfo = await this.callApi<{ id?: number; username?: string }>("getMe");
    await this.callApi("setMyCommands", {
      commands: [
        { command: "new", description: "发短信（默认爱尔兰 +353）" },
        { command: "inbox", description: "查看最近会话" },
        { command: "unread", description: "查看未读短信" },
        { command: "chat", description: "查看对话：/chat 号码" },
        { command: "send", description: "快速发送：/send 号码 内容" },
        { command: "contacts", description: "查看或搜索通讯录" },
        { command: "contact", description: "添加联系人备注" },
        { command: "status", description: "查看设备与网络状态" },
        { command: "help", description: "查看使用说明" },
      ],
    }).catch(() => {});

    this.#running = true;
    void this.#pollLoop();
  }

  stop(): void {
    this.#running = false;
    if (this.#pollAbort) {
      this.#pollAbort.abort();
      this.#pollAbort = null;
    }
  }

  async #pollLoop(): Promise<void> {
    let backoffMs = 1500;
    while (this.#running) {
      this.#pollAbort = new AbortController();
      try {
        const updates = await this.callApi<TelegramUpdate[]>(
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
          this.handleUpdate(update).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[TelegramBot] Update handler error:", msg);
          });
        }
      } catch (err) {
        if (!this.#running) break;
        if (err instanceof Error && err.name === "AbortError") continue;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[TelegramBot] Poll error (${msg}), retrying in ${backoffMs}ms...`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(30000, backoffMs * 2);
      }
    }
  }

  async notifyNewSms(sms: SmsMessage): Promise<void> {
    const targets = this.stateStore.getAllAuthorizedChats(this.allowedChatIds);
    if (targets.length === 0) {
      console.warn(
        `[TelegramBot] 收到来自 ${sms.phone} 的新短信 (#${sms.index})，但尚未绑定授权 Telegram 会话。`
      );
      return;
    }

    const info = this.formatSenderSummary(sms.phone, sms.content);
    const otp = sms.verificationCode ?? extractVerificationCode(sms.content);

    const lines = [`<b>新短信</b>`];
    if (info.whoLine) lines.push("", info.whoLine);
    lines.push(info.phoneLine);
    lines.push(`<b>时间：</b>${escapeTelegramHtml(sms.date)}`);
    if (otp) {
      lines.push("", "<b>验证码</b>", `<code>${escapeTelegramHtml(otp)}</code>`);
    }
    lines.push("", `<blockquote>${escapeTelegramHtml(sms.content.slice(0, 3300))}`);
    if (sms.content.length > 3300) {
      lines[lines.length - 1] = `${lines[lines.length - 1]}\n…内容已截断`;
    }
    lines[lines.length - 1] = `${lines[lines.length - 1]}</blockquote>`;
    const replyNumber = info.sender.e164 ?? sms.phone;
    if (info.sender.dialable && isDialablePhone(replyNumber)) {
      lines.push(
        "",
        `<i>回复此消息即可发送至 <code>${escapeTelegramHtml(replyNumber)}</code></i>`
      );
    }

    const row: Array<{ text: string; callback_data: string }> = [];
    const readCb = makeCallbackData("read", sms.index);
    const chatCb = makeCallbackData("chat", sms.phone);
    const delCb = makeCallbackData("del", sms.index);
    if (sms.isUnread && readCb) row.push({ text: "标为已读", callback_data: readCb });
    if (chatCb) row.push({ text: "查看对话", callback_data: chatCb });
    if (delCb) row.push({ text: "删除", callback_data: delCb });

    for (const chatId of targets) {
      try {
        const sent = await this.callApi<{ message_id?: number }>("sendMessage", {
          chat_id: chatId,
          text: lines.join("\n"),
          parse_mode: "HTML",
          reply_markup: row.length > 0 ? { inline_keyboard: [row] } : undefined,
        });
        if (sent?.message_id && sms.phone) {
          this.stateStore.bindReplyTarget(chatId, sent.message_id, replyNumber);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[TelegramBot] Failed to notify chat ${chatId}:`, msg);
      }
    }
  }

  async notifyStorageWarning(info: {
    localInbox: number;
    localMax: number;
    storageFull: boolean;
  }): Promise<void> {
    const targets = this.stateStore.getAllAuthorizedChats(this.allowedChatIds);
    const title = info.storageFull
      ? "<b>存储空间已满</b>"
      : "<b>存储空间提醒</b>";
    const text = [
      title,
      "",
      `<b>收件箱：</b>${info.localInbox} / ${info.localMax}`,
      info.storageFull
        ? "CPE 目前无法接收新短信，请及时清理旧短信。"
        : "存储即将占满，请及时清理旧短信。",
      "<i>本地历史归档不受影响。</i>",
    ].join("\n");

    for (const chatId of targets) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }).catch(() => {});
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.#handleCallbackQuery(update.callback_query);
      return;
    }
    if (update.message) {
      await this.#handleMessage(update.message);
    }
  }

  #isAuthRateLimited(chatId: string): boolean {
    const entry = this.#failedAuthAttempts.get(chatId);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      this.#failedAuthAttempts.delete(chatId);
      return false;
    }
    return entry.count >= 5;
  }

  #recordFailedAuth(chatId: string): void {
    const now = Date.now();
    const cur = this.#failedAuthAttempts.get(chatId);
    if (!cur || now > cur.resetAt) {
      this.#failedAuthAttempts.set(chatId, { count: 1, resetAt: now + 10 * 60 * 1000 });
    } else {
      cur.count += 1;
    }
  }

  #getWizard(chatId: string): WizardSession | null {
    const w = this.#wizards.get(chatId);
    if (!w) return null;
    if (Date.now() > w.expiresAt) {
      this.#wizards.delete(chatId);
      return null;
    }
    return w;
  }

  #buildWizardPhoneKeyboard(activeCode: string): {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  } {
    const btns = WIZARD_QUICK_COUNTRIES.map((c) => ({
      text: c.code === activeCode ? `${c.label} ✓` : c.label,
      callback_data: `wizcc:${c.code}`,
    }));
    return {
      inline_keyboard: [
        btns.slice(0, 2),
        btns.slice(2, 5),
        [{ text: "取消", callback_data: "wizcancel:1" }],
      ],
    };
  }

  #buildWizardPhonePromptHtml(activeCode: string): string {
    const country = getCountryByDialCode(activeCode);
    const label = country ? `${country.nameZh} (${country.code})` : activeCode;
    const example =
      activeCode === "+353"
        ? "<code>0831234567</code> 或 <code>831234567</code>"
        : activeCode === "+86"
          ? "<code>13800138000</code>"
          : activeCode === "+44"
            ? "<code>07911123456</code>"
            : "本地手机号";

    return [
      `<b>发短信</b>`,
      ``,
      `<b>第 1 步：选择收件人</b>`,
      `<b>当前国家：</b>${escapeTelegramHtml(label)}`,
      ``,
      `直接发送以下任一内容：`,
      `• 本地号码，如 ${example}`,
      `• 国际号码，如 <code>+8613800138000</code>`,
      `• 联系人姓名，如 <code>John</code>`,
    ].join("\n");
  }

  async startSendWizard(chatId: string, initialCountry = this.defaultCountryCode): Promise<void> {
    this.#wizards.set(chatId, {
      step: "awaiting_phone",
      countryCode: initialCountry,
      expiresAt: Date.now() + WIZARD_TTL_MS,
    });
    await this.#sendHtml(chatId, this.#buildWizardPhonePromptHtml(initialCountry), {
      reply_markup: this.#buildWizardPhoneKeyboard(initialCountry),
    });
  }

  async #handleWizardInput(chatId: string, text: string): Promise<boolean> {
    const wiz = this.#getWizard(chatId);
    if (!wiz) return false;

    wiz.expiresAt = Date.now() + WIZARD_TTL_MS;

    if (wiz.step === "awaiting_phone") {
      if (/[A-Za-z\u4e00-\u9fa5]/.test(text) && this.contactStore) {
        const matches = this.contactStore.search(text, 8);
        if (matches.length === 0) {
          await this.#sendHtml(
            chatId,
            [
              "<b>未找到联系人</b>",
              "",
              `没有匹配“${escapeTelegramHtml(text)}”的记录。`,
              "请直接输入手机号，或发送 iPhone 导出的 <code>.vcf</code> 文件。",
            ].join("\n"),
            { reply_markup: this.#buildWizardPhoneKeyboard(wiz.countryCode) }
          );
          return true;
        }
        if (matches.length === 1 && matches[0]?.phones.length === 1 && matches[0].phones[0]) {
          return await this.#advanceWizardToContent(chatId, matches[0].phones[0]);
        }

        const rows: Array<Array<{ text: string; callback_data: string }>> = [];
        for (const c of matches) {
          for (const ph of c.phones.slice(0, 2)) {
            const cb = makeCallbackData("wizpick", ph);
            if (cb) {
              rows.push([{ text: `${c.name} · ${ph}`, callback_data: cb }]);
            }
          }
        }
        rows.push([{ text: "取消", callback_data: "wizcancel:1" }]);
        await this.#sendHtml(chatId, "<b>选择收件人</b>\n\n找到以下匹配联系人：", {
          reply_markup: { inline_keyboard: rows.slice(0, 9) },
        });
        return true;
      }

      const resolved = resolveRecipientPhone(text, wiz.countryCode);
      if (!resolved.ok) {
        await this.#sendHtml(chatId, `<b>号码无效</b>\n\n${escapeTelegramHtml(resolved.error)}`, {
          reply_markup: this.#buildWizardPhoneKeyboard(wiz.countryCode),
        });
        return true;
      }

      return await this.#advanceWizardToContent(chatId, resolved.phone);
    }

    if (wiz.step === "awaiting_content") {
      const modeInfo = detectSmsTextMode(text);
      if (modeInfo.segments > 4) {
        await this.#sendHtml(
          chatId,
          [
            "<b>短信过长</b>",
            "",
            `当前将占用 ${modeInfo.segments} 条分段，CPE 单次最多支持 4 条。`,
            "请精简后重新发送。",
          ].join("\n")
        );
        return true;
      }

      wiz.step = "awaiting_confirm";
      wiz.content = text;

      const previewHtml = [
        `<b>确认发送</b>`,
        ``,
        `<b>收件人：</b>${wiz.phoneLabel ?? ""}`,
        `<b>编码：</b>${modeInfo.encoding} · ${modeInfo.segments} 条`,
        ``,
        `<blockquote>${escapeTelegramHtml(text)}</blockquote>`,
      ].join("\n");

      await this.#sendHtml(chatId, previewHtml, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "立即发送", callback_data: "wizsend:1" },
              { text: "修改内容", callback_data: "wizback:content" },
            ],
            [
              { text: "更换号码", callback_data: "wizback:phone" },
              { text: "取消", callback_data: "wizcancel:1" },
            ],
          ],
        },
      });
      return true;
    }

    if (wiz.step === "awaiting_confirm") {
      await this.#sendHtml(
        chatId,
        "请点击上方「立即发送」按钮，或选择「取消」。"
      );
      return true;
    }

    return false;
  }

  async #advanceWizardToContent(chatId: string, normalizedPhone: string): Promise<boolean> {
    const wiz = this.#getWizard(chatId);
    if (!wiz) return false;
    const summary = this.formatSenderSummary(normalizedPhone);
    wiz.step = "awaiting_content";
    wiz.phone = normalizedPhone;
    wiz.phoneLabel = summary.shortTitle;
    wiz.expiresAt = Date.now() + WIZARD_TTL_MS;

    await this.#sendHtml(
      chatId,
      [
        `<b>发短信</b>`,
        ``,
        `<b>第 2 步：输入正文</b>`,
        `<b>收件人：</b>${summary.shortTitle}`,
        ``,
        `直接发送短信正文即可。`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "更换号码", callback_data: "wizback:phone" },
              { text: "取消", callback_data: "wizcancel:1" },
            ],
          ],
        },
      }
    );
    return true;
  }

  async #handleMessage(msg: NonNullable<TelegramUpdate["message"]>): Promise<void> {
    const chatId = String(msg.chat?.id ?? "");
    if (!chatId) return;

    const authorized = this.stateStore.isChatAuthorized(chatId, this.allowedChatIds);

    if (msg.document && authorized && this.contactStore) {
      const fileName = String(msg.document.file_name ?? "");
      const mime = String(msg.document.mime_type ?? "");
      if (/\.vcf$/i.test(fileName) || /vcard/i.test(mime)) {
        try {
          const vcfText = await this.downloadTelegramFileText(msg.document.file_id);
          const stats = this.contactStore.importVcard(vcfText);
          this.archiveStore?.emit("contacts:updated", { total: stats.total });
          await this.#sendHtml(
            chatId,
            [
              `<b>通讯录已导入</b>`,
              ``,
              `<b>解析记录：</b>${stats.parsed}`,
              `<b>新增联系人：</b>${stats.added}`,
              `<b>合并更新：</b>${stats.updated}`,
              `<b>通讯录总数：</b>${stats.total}`,
              "",
              `<i>数据已通过 AES-256-GCM 加密保存在本地 data/contacts.json。</i>`,
            ].join("\n")
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await this.#sendHtml(
            chatId,
            `<b>通讯录导入失败</b>\n\n${escapeTelegramHtml(errMsg)}`
          );
        }
        return;
      }
    }

    const text = (msg.text ?? "").trim();
    if (!text) return;

    if (/^\/auth(?:@\S+)?(?:\s+|$)/i.test(text)) {
      const arg = text.replace(/^\/auth(?:@\S+)?\s*/i, "");
      if (msg.message_id) {
        this.callApi("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(
          () => {}
        );
      }

      if (authorized) {
        await this.#sendHtml(
          chatId,
          `<b>会话已授权</b>\n\nChat ID：<code>${chatId}</code>`
        );
        return;
      }
      if (this.#isAuthRateLimited(chatId)) {
        await this.#sendHtml(
          chatId,
          "<b>验证暂时停用</b>\n\n失败次数过多，请 10 分钟后再试。"
        );
        return;
      }
      if (!arg) {
        await this.#sendHtml(
          chatId,
          `用法：<code>/auth 你的CPE登录密码</code>`
        );
        return;
      }
      if (safeEqualString(arg, this.cpePassword)) {
        this.stateStore.authorizeChat(chatId);
        this.#failedAuthAttempts.delete(chatId);
        await this.#sendHtml(
          chatId,
          [
            `<b>绑定成功</b>`,
            ``,
            `<b>Chat ID：</b><code>${chatId}</code>`,
            "密码消息已自动撤回。",
            "CPE 收到的所有新短信都会实时推送到这里。",
          ].join("\n")
        );
        await this.#cmdStatus(chatId);
      } else {
        this.#recordFailedAuth(chatId);
        await this.#sendHtml(
          chatId,
          "<b>密码不正确</b>\n\n请检查后重试。"
        );
      }
      return;
    }

    if (!authorized) {
      await this.#sendHtml(
        chatId,
        [
          `<b>CPE 短信网关</b>`,
          ``,
          "当前会话尚未授权。",
          `<b>Chat ID：</b><code>${escapeTelegramHtml(chatId)}</code>`,
          "",
          "发送以下命令完成安全绑定：",
          `<code>/auth 你的CPE管理界面密码</code>`,
        ].join("\n")
      );
      return;
    }

    if (/^\/cancel(?:@\S+)?$/i.test(text)) {
      if (this.#wizards.delete(chatId)) {
        await this.#sendHtml(chatId, "<b>已取消</b>\n\n当前发送流程已结束。");
      } else {
        await this.#sendHtml(chatId, "当前没有进行中的发送流程。");
      }
      return;
    }

    if (!text.startsWith("/") && msg.reply_to_message?.message_id) {
      const targetPhone = this.stateStore.getReplyTarget(chatId, msg.reply_to_message.message_id);
      if (targetPhone) {
        if (!isDialablePhone(targetPhone)) {
          await this.#sendHtml(
            chatId,
            [
              "<b>无法直接回复</b>",
              "",
              `<code>${escapeTelegramHtml(targetPhone)}</code> 是字母服务号。`,
            ].join("\n")
          );
          return;
        }
        this.#wizards.delete(chatId);
        await this.#executeSendSms(chatId, targetPhone, text);
        return;
      }
    }

    if (!text.startsWith("/") && this.#getWizard(chatId)) {
      await this.#handleWizardInput(chatId, text);
      return;
    }

    const cmdMatch = text.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
    if (!cmdMatch) {
      await this.#sendHtml(
        chatId,
        [
          "<b>发送短信</b>",
          "",
          "点击下方按钮发短信，或直接回复任意一条短信通知。",
        ].join("\n"),
        {
          reply_markup: {
            inline_keyboard: [[{ text: "发短信", callback_data: "wizstart:1" }]],
          },
        }
      );
      return;
    }

    this.#wizards.delete(chatId);

    const cmd = (cmdMatch[1] ?? "").toLowerCase();
    const rest = (cmdMatch[2] ?? "").trim();

    switch (cmd) {
      case "start":
      case "help":
        await this.#cmdHelp(chatId);
        break;
      case "new":
      case "compose":
        await this.startSendWizard(chatId);
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
        if (!rest) {
          await this.startSendWizard(chatId);
        } else {
          await this.#cmdSend(chatId, rest);
        }
        break;
      case "contacts":
        await this.#cmdContacts(chatId, rest);
        break;
      case "contact":
        await this.#cmdUpsertContact(chatId, rest);
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
        await this.#sendHtml(
          chatId,
          [
            "<b>未知命令</b>",
            "",
            `<code>/${escapeTelegramHtml(cmd)}</code> 不可用。发送 /help 查看说明。`,
          ].join("\n")
        );
    }
  }

  async #handleCallbackQuery(
    cq: NonNullable<TelegramUpdate["callback_query"]>
  ): Promise<void> {
    const chatId = String(cq.message?.chat?.id ?? "");
    const messageId = cq.message?.message_id;
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
      if (action === "wizstart") {
        await this.callApi("answerCallbackQuery", { callback_query_id: cq.id });
        await this.startSendWizard(chatId);
        return;
      }
      if (action === "wizcancel") {
        this.#wizards.delete(chatId);
        await this.callApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "已取消发短信",
        });
        if (messageId) {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: "<b>已取消</b>\n\n当前发送流程已结束。",
            parse_mode: "HTML",
          }).catch(() => {});
        }
        return;
      }
      if (action === "wizcc") {
        const wiz: WizardSession = this.#getWizard(chatId) ?? {
          step: "awaiting_phone",
          countryCode: arg,
          expiresAt: Date.now() + WIZARD_TTL_MS,
        };
        wiz.countryCode = arg;
        wiz.step = "awaiting_phone";
        wiz.expiresAt = Date.now() + WIZARD_TTL_MS;
        this.#wizards.set(chatId, wiz);

        await this.callApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `已切换默认区号为 ${arg}`,
        });
        if (messageId) {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: this.#buildWizardPhonePromptHtml(arg),
            parse_mode: "HTML",
            reply_markup: this.#buildWizardPhoneKeyboard(arg),
          }).catch(() => {});
        }
        return;
      }
      if (action === "wizpick") {
        await this.callApi("answerCallbackQuery", { callback_query_id: cq.id });
        await this.#advanceWizardToContent(chatId, arg);
        return;
      }
      if (action === "wizback") {
        await this.callApi("answerCallbackQuery", { callback_query_id: cq.id });
        const wiz = this.#getWizard(chatId);
        if (!wiz || arg === "phone") {
          await this.startSendWizard(chatId, wiz?.countryCode ?? this.defaultCountryCode);
        } else if (arg === "content" && wiz.phone) {
          await this.#advanceWizardToContent(chatId, wiz.phone);
        }
        return;
      }
      if (action === "wizsend") {
        const wiz = this.#getWizard(chatId);
        if (!wiz || !wiz.phone || !wiz.content) {
          await this.callApi("answerCallbackQuery", {
            callback_query_id: cq.id,
            text: "发送会话已过期，请重新点击发送短信",
            show_alert: true,
          });
          return;
        }
        this.#wizards.delete(chatId);
        await this.callApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "正在提交发送...",
        });
        await this.#executeSendSms(chatId, wiz.phone, wiz.content, messageId);
        return;
      }

      if (action === "read") {
        await this.cpeClient.markRead([arg]);
        this.archiveStore?.markReadByCpeIndices([arg]);
        await this.callApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `短信 #${arg} 已设为已读`,
        });
      } else if (action === "readall") {
        const inbox = await this.cpeClient.fetchRecentInboxMessages({
          count: 50,
          unreadOnly: true,
        });
        const ids = (inbox?.messages ?? []).map((m) => m.index);
        if (ids.length > 0) {
          await this.cpeClient.markRead(ids);
          this.archiveStore?.markReadByCpeIndices(ids);
        }
        await this.callApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: ids.length > 0 ? `已将 ${ids.length} 条短信设为已读` : "当前没有未读短信",
        });
      } else if (action === "del") {
        await this.cpeClient.deleteSms([arg]);
        this.archiveStore?.markDeletedByCpeIndices([arg]);
        await this.callApi("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: `已从 CPE 删除短信 #${arg}`,
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
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.callApi("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `操作失败: ${errMsg.slice(0, 120)}`,
        show_alert: true,
      }).catch(() => {});
    }
  }

  async #sendHtml(
    chatId: string,
    html: string,
    extra: Record<string, unknown> = {}
  ): Promise<{ message_id?: number }> {
    return await this.callApi<{ message_id?: number }>("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      ...extra,
    });
  }

  async #cmdHelp(chatId: string): Promise<void> {
    const defCountry = getCountryByDialCode(this.defaultCountryCode);
    const defLabel = defCountry
      ? `${defCountry.nameZh} (${defCountry.code})`
      : this.defaultCountryCode;

    const html = [
      `<b>短信助手</b>`,
      ``,
      `华为 5G CPE Ultra 6 (H168-383)`,
      "",
      `<b>常用操作</b>`,
      `/new  发短信 · 默认 ${escapeTelegramHtml(defLabel)}`,
      `/inbox  最近会话`,
      `/unread  未读短信`,
      `/status  设备与网络状态`,
      ``,
      `<b>更多命令</b>`,
      `/chat <code>号码</code>  查看对话`,
      `/send <code>号码 内容</code>  快速发送`,
      `/contact <code>号码 姓名</code>  添加联系人`,
      `/contacts <code>[关键词]</code>  搜索通讯录`,
      `/sync  同步收件箱与归档`,
      "",
      "<b>快捷回复</b>",
      "直接回复任意短信通知即可回信。",
      "",
      "<b>导入通讯录</b>",
      "把 iPhone 导出的 <code>.vcf</code> 文件发送给机器人。",
    ].join("\n");

    await this.#sendHtml(chatId, html, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "发短信", callback_data: "wizstart:1" }],
          [
            { text: "最近会话", callback_data: "inbox:1" },
            { text: "未读", callback_data: "unread:1" },
            { text: "状态", callback_data: "status:1" },
          ],
        ],
      },
    });
  }

  async #cmdStatus(chatId: string): Promise<void> {
    try {
      const s = await this.cpeClient.getStatusSummary();
      const lines = [
        `<b>${escapeTelegramHtml(s.device.marketingName || s.device.deviceName)}</b>`,
        `${escapeTelegramHtml(s.device.deviceName)}`,
        "",
        `<b>地址：</b><code>${escapeTelegramHtml(this.cpeClient.baseUrl)}</code>`,
      ];
      if (s.network?.operatorName || s.network?.numericPlmn) {
        lines.push(
          `<b>运营商：</b>${escapeTelegramHtml(s.network.operatorName || s.network.numericPlmn)}`
        );
      }
      if (s.signal) {
        const sigParts: string[] = [];
        if (s.signal.nrRsrp) {
          sigParts.push(`5G RSRP ${s.signal.nrRsrp} / SINR ${s.signal.nrSinr || "-"}`);
        }
        if (s.signal.rsrp) {
          sigParts.push(`4G RSRP ${s.signal.rsrp} / SINR ${s.signal.sinr || "-"}`);
        }
        if (sigParts.length > 0) {
          lines.push(`<b>信号：</b>${escapeTelegramHtml(sigParts.join(" · "))}`);
        }
      }
      if (s.sms) {
        lines.push(
          "",
          `<b>未读：</b>${s.sms.localUnread}`,
          `<b>收件箱：</b>${s.sms.localInbox} / ${s.sms.localMax}`,
          `<b>发件箱：</b>${s.sms.localOutbox} · <b>会话：</b>${s.sms.contactThreads}`
        );
      }
      if (this.archiveStore) {
        lines.push(
          "",
          `<b>本地归档：</b>${this.archiveStore.messages.size} 条短信`,
          `<b>通讯录：</b>${this.contactStore?.contacts.length ?? 0} 位`
        );
      }
      await this.#sendHtml(chatId, lines.join("\n"), {
        reply_markup: {
          inline_keyboard: [
            [{ text: "发短信", callback_data: "wizstart:1" }],
            [
              { text: "收件箱", callback_data: "inbox:1" },
              { text: "未读", callback_data: "unread:1" },
            ],
          ],
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.#sendHtml(
        chatId,
        `<b>无法获取状态</b>\n\n${escapeTelegramHtml(errMsg)}`
      );
    }
  }

  async #cmdInbox(chatId: string, page = 1): Promise<void> {
    try {
      const pageSize = 8;
      const res = await this.cpeClient.listContacts({ page, count: pageSize });
      if (!res || res.contacts.length === 0) {
        await this.#sendHtml(chatId, "<b>暂无会话</b>\n\n当前没有短信记录。", {
          reply_markup: {
            inline_keyboard: [[{ text: "写第一条短信", callback_data: "wizstart:1" }]],
          },
        });
        return;
      }

      const totalPages = Math.max(1, Math.ceil(res.total / pageSize));
      const lines = [
        `<b>最近会话</b>`,
        `第 ${page} / ${totalPages} 页 · 共 ${res.total} 个联系人`,
        "",
      ];

      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
        [{ text: "发短信", callback_data: "wizstart:1" }],
      ];
      let currentRow: Array<{ text: string; callback_data: string }> = [];

      for (const c of res.contacts) {
        const status = c.isUnread ? "未读" : c.direction === "out" ? "已发送" : "已接收";
        const info = this.formatSenderSummary(c.phone, c.content);
        const preview = c.content.replace(/\s+/g, " ").slice(0, 48);
        lines.push(
          `<b>${status}</b> · ${info.shortTitle}`,
          `<i>${escapeTelegramHtml(c.date)}</i>`,
          escapeTelegramHtml(preview) + (c.content.length > 48 ? "…" : ""),
          ""
        );

        const cb = makeCallbackData("chat", c.phone);
        if (cb) {
          const btnName = info.contact ? info.contact.name : c.phone;
          currentRow.push({
            text: btnName.slice(0, 12),
            callback_data: cb,
          });
          if (currentRow.length === 2) {
            keyboard.push(currentRow);
            currentRow = [];
          }
        }
      }
      if (currentRow.length > 0) keyboard.push(currentRow);

      const navRow: Array<{ text: string; callback_data: string }> = [];
      if (page > 1) navRow.push({ text: "上一页", callback_data: `inbox:${page - 1}` });
      if (page < totalPages) navRow.push({ text: "下一页", callback_data: `inbox:${page + 1}` });
      if (navRow.length > 0) keyboard.push(navRow);

      await this.#sendHtml(chatId, lines.join("\n"), {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.#sendHtml(
        chatId,
        `<b>无法读取会话</b>\n\n${escapeTelegramHtml(errMsg)}`
      );
    }
  }

  async #cmdUnread(chatId: string): Promise<void> {
    try {
      const res = await this.cpeClient.fetchRecentInboxMessages({ count: 10, unreadOnly: true });
      if (!res || res.messages.length === 0) {
        await this.#sendHtml(chatId, "<b>没有未读短信</b>");
        return;
      }

      const lines = [
        `<b>未读短信</b>`,
        `显示 ${res.messages.length} 条 · 共 ${res.localUnread} 条`,
        "",
      ];
      for (const m of res.messages) {
        const info = this.formatSenderSummary(m.phone, m.content);
        const otp = extractVerificationCode(m.content);
        const otpLine = otp ? `\n<b>验证码：</b><code>${escapeTelegramHtml(otp)}</code>` : "";
        lines.push(
          `<b>#${m.index}</b> · ${info.shortTitle}`,
          `<i>${escapeTelegramHtml(m.date)}</i>`,
          escapeTelegramHtml(m.content.replace(/\s+/g, " ").slice(0, 120)) +
            (m.content.length > 120 ? "…" : "") +
            otpLine,
          ""
        );
      }

      await this.#sendHtml(chatId, lines.join("\n"), {
        reply_markup: {
          inline_keyboard: [[{ text: "全部标为已读", callback_data: "readall:1" }]],
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.#sendHtml(
        chatId,
        `<b>无法读取未读短信</b>\n\n${escapeTelegramHtml(errMsg)}`
      );
    }
  }

  async #cmdChat(chatId: string, phoneArg: string): Promise<void> {
    const phone = phoneArg.trim();
    if (!phone) {
      await this.#sendHtml(
        chatId,
        [
          "<b>查看对话</b>",
          "",
          "用法：<code>/chat 号码或发件人</code>",
          "示例：<code>/chat +353831234567</code>",
        ].join("\n")
      );
      return;
    }

    try {
      const res = await this.cpeClient.listPhoneMessages(phone, { page: 1, count: 12 });
      if (!res || res.messages.length === 0) {
        await this.#sendHtml(
          chatId,
          `<b>没有找到对话</b>\n\n<code>${escapeTelegramHtml(phone)}</code>`
        );
        return;
      }

      const lastContent = res.messages[res.messages.length - 1]?.content ?? "";
      const info = this.formatSenderSummary(phone, lastContent);
      const lines = [
        `<b>${info.shortTitle}</b>`,
        `共 ${res.total} 条短信`,
        "",
      ];
      const recent = res.messages.slice(-10);
      const senderLabel = info.contact ? info.contact.name : phone;

      for (const m of recent) {
        const author =
          m.direction === "out"
            ? "<b>我</b>"
            : `<b>${escapeTelegramHtml(senderLabel)}</b>`;
        const unreadLabel = m.isUnread ? " · <b>未读</b>" : "";
        lines.push(
          `${author} <i>${escapeTelegramHtml(m.date)} · #${m.index}</i>${unreadLabel}`,
          `<blockquote>${escapeTelegramHtml(m.content.slice(0, 300))}</blockquote>`,
          ""
        );
      }

      const replyTarget = info.sender.e164 ?? phone;
      if (info.sender.dialable && isDialablePhone(replyTarget)) {
        lines.push(
          `<i>回复此消息即可发送至 <code>${escapeTelegramHtml(replyTarget)}</code></i>`
        );
      }

      const sent = await this.#sendHtml(chatId, lines.join("\n").slice(0, 4000));
      if (sent?.message_id) {
        this.stateStore.bindReplyTarget(chatId, sent.message_id, replyTarget);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.#sendHtml(
        chatId,
        `<b>无法读取对话</b>\n\n${escapeTelegramHtml(errMsg)}`
      );
    }
  }

  async #cmdSend(chatId: string, rest: string): Promise<void> {
    const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
    if (!match?.[1] || !match[2]) {
      await this.startSendWizard(chatId);
      return;
    }
    const resolved = resolveRecipientPhone(match[1], this.defaultCountryCode);
    if (!resolved.ok) {
      await this.#sendHtml(
        chatId,
        `<b>号码无效</b>\n\n${escapeTelegramHtml(resolved.error)}`
      );
      return;
    }
    await this.#executeSendSms(chatId, resolved.phone, match[2]);
  }

  async #cmdContacts(chatId: string, query: string): Promise<void> {
    if (!this.contactStore) {
      await this.#sendHtml(chatId, "<b>通讯录未启用</b>");
      return;
    }
    const list = this.contactStore.search(query, 20);
    if (list.length === 0) {
      await this.#sendHtml(
        chatId,
        [
          "<b>没有找到联系人</b>",
          "",
          query
            ? `没有匹配“${escapeTelegramHtml(query)}”的记录。`
            : "当前通讯录为空。",
          ``,
          `<b>添加方式：</b>`,
          `• 把 iPhone 导出的 <code>.vcf</code> 文件发送到这里`,
          `• 发送 <code>/contact +353831234567 房东John</code>`,
        ].join("\n")
      );
      return;
    }

    const lines = [
      `<b>联系人</b>`,
      `显示 ${list.length} 位 · 共 ${this.contactStore.contacts.length} 位`,
      "",
    ];
    for (const c of list) {
      lines.push(
        `<b>${escapeTelegramHtml(c.name)}</b>`,
        `<code>${escapeTelegramHtml(c.phones.join(", "))}</code>`,
        ""
      );
    }
    await this.#sendHtml(chatId, lines.join("\n"));
  }

  async #cmdUpsertContact(chatId: string, rest: string): Promise<void> {
    if (!this.contactStore) return;
    const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
    if (!match?.[1] || !match[2]) {
      await this.#sendHtml(
        chatId,
        [
          "<b>添加联系人</b>",
          "",
          "用法：<code>/contact 号码 备注姓名</code>",
          "示例：<code>/contact 0831234567 房东John</code>",
        ].join("\n")
      );
      return;
    }
    try {
      const saved = this.contactStore.upsertManualContact({
        phone: match[1],
        name: match[2],
      });
      this.archiveStore?.emit("contacts:updated", { total: this.contactStore.contacts.length });
      await this.#sendHtml(
        chatId,
        [
          "<b>联系人已保存</b>",
          "",
          `<b>${escapeTelegramHtml(saved.name)}</b>`,
          `<code>${escapeTelegramHtml(saved.phones[0] ?? "")}</code>`,
        ].join("\n")
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.#sendHtml(
        chatId,
        `<b>无法保存联系人</b>\n\n${escapeTelegramHtml(errMsg)}`
      );
    }
  }

  async #executeSendSms(
    chatId: string,
    phone: string,
    content: string,
    existingMessageId?: number
  ): Promise<void> {
    const info = this.formatSenderSummary(phone);
    let msgId = existingMessageId;

    if (msgId) {
      await this.callApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: `<b>正在发送</b>\n\n收件人：${info.shortTitle}`,
        parse_mode: "HTML",
      }).catch(() => {});
    } else {
      const pending = await this.#sendHtml(
        chatId,
        `<b>正在发送</b>\n\n收件人：${info.shortTitle}`
      );
      msgId = pending?.message_id;
    }

    try {
      const result = await this.cpeClient.sendSms(phone, content);
      if (result.ok) {
        this.archiveStore?.recordRealtimeMessage(
          {
            index: 0,
            phone,
            content,
            date: formatHuaweiDate(new Date()),
            smstat: "3",
            curbox: "1",
            isUnread: false,
            direction: "out",
          },
          "sms:sent"
        );
      }

      const resultText = result.ok
        ? [
            `<b>短信已发送</b>`,
            ``,
            `<b>收件人：</b>${info.shortTitle}`,
            `<b>编码：</b>${result.encoding} · ${result.segments} 条`,
            ``,
            `<blockquote>${escapeTelegramHtml(content.slice(0, 1000))}</blockquote>`,
          ].join("\n")
        : [
            `<b>短信发送失败</b>`,
            ``,
            `<b>收件人：</b>${info.shortTitle}`,
            result.failCode
              ? `<b>错误码：</b><code>${escapeTelegramHtml(result.failCode)}</code>`
              : "",
          ]
            .filter(Boolean)
            .join("\n");

      if (msgId) {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: resultText,
          parse_mode: "HTML",
        });
        this.stateStore.bindReplyTarget(chatId, msgId, phone);
      } else {
        await this.#sendHtml(chatId, resultText);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errHtml = `<b>发送失败</b>\n\n${escapeTelegramHtml(errMsg)}`;
      if (msgId) {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: errHtml,
          parse_mode: "HTML",
        }).catch(() => this.#sendHtml(chatId, errHtml));
      } else {
        await this.#sendHtml(chatId, errHtml);
      }
    }
  }

  async #cmdRead(chatId: string, arg: string): Promise<void> {
    if (!arg) {
      await this.#sendHtml(
        chatId,
        [
          "<b>标为已读</b>",
          "",
          "用法：<code>/read 短信ID</code> 或 <code>/read all</code>",
        ].join("\n")
      );
      return;
    }
    try {
      if (arg.toLowerCase() === "all") {
        const res = await this.cpeClient.fetchRecentInboxMessages({ count: 50, unreadOnly: true });
        const ids = (res?.messages ?? []).map((m) => m.index);
        if (ids.length === 0) {
          await this.#sendHtml(chatId, "<b>没有未读短信</b>");
          return;
        }
        await this.cpeClient.markRead(ids);
        this.archiveStore?.markReadByCpeIndices(ids);
        await this.#sendHtml(
          chatId,
          `<b>已标为已读</b>\n\n共 ${ids.length} 条短信。`
        );
      } else {
        const ids = arg.split(/[\s,]+/).filter(Boolean);
        const r = await this.cpeClient.markRead(ids);
        this.archiveStore?.markReadByCpeIndices(ids);
        await this.#sendHtml(
          chatId,
          `<b>已标为已读</b>\n\n共 ${r.count} 条短信。`
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.#sendHtml(
        chatId,
        `<b>操作失败</b>\n\n${escapeTelegramHtml(errMsg)}`
      );
    }
  }

  async #cmdDelete(chatId: string, arg: string): Promise<void> {
    if (!arg) {
      await this.#sendHtml(
        chatId,
        [
          "<b>删除短信</b>",
          "",
          "用法：<code>/delete 短信ID</code>",
          "示例：<code>/delete 40182</code>",
        ].join("\n")
      );
      return;
    }
    try {
      const ids = arg.split(/[\s,]+/).filter(Boolean);
      const r = await this.cpeClient.deleteSms(ids);
      this.archiveStore?.markDeletedByCpeIndices(ids);
      await this.#sendHtml(
        chatId,
        `<b>短信已删除</b>\n\n共 ${r.count} 条。`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.#sendHtml(
        chatId,
        `<b>删除失败</b>\n\n${escapeTelegramHtml(errMsg)}`
      );
    }
  }

  async #cmdSync(chatId: string): Promise<void> {
    try {
      if (this.poller) {
        const dump = await this.poller.syncFullHistory({ respectBrowserSession: false });
        await this.#sendHtml(
          chatId,
          dump
            ? [
                "<b>同步完成</b>",
                "",
                `<b>CPE 短信：</b>${dump.messages.length} 条`,
                `<b>未读：</b>${dump.localUnread} 条`,
                `<b>本地归档：</b>${this.archiveStore?.messages.size ?? dump.messages.length} 条`,
              ].join("\n")
            : "<b>同步已执行</b>"
        );
      } else {
        await this.#cmdUnread(chatId);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.#sendHtml(
        chatId,
        `<b>同步失败</b>\n\n${escapeTelegramHtml(errMsg)}`
      );
    }
  }
}
