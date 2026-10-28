import path from "node:path";
import { pathToFileURL } from "node:url";
import type { StateStore } from "../src/state-store.ts";
import { TelegramSmsBot } from "../src/telegram-bot.ts";

interface CapturedCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface TelegramStylePreview {
  name: string;
  payload: Record<string, unknown>;
}

interface InlineKeyboardMarkup {
  inline_keyboard?: Array<Array<{ text: string }>>;
}

function createPreviewBot(calls: CapturedCall[]): TelegramSmsBot {
  let nextMessageId = 600;
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const method = String(input).split("/").pop() ?? "";
    const payload = init.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    calls.push({ method, payload });
    nextMessageId += 1;
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: nextMessageId } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const stateStore = {
    getAllAuthorizedChats: () => ["preview-chat"],
    isChatAuthorized: () => true,
    bindReplyTarget: () => undefined,
  } as unknown as StateStore;

  const cpeClient = {
    baseUrl: "http://192.168.8.1",
    getStatusSummary: async () => ({
      device: {
        deviceName: "H168-383",
        marketingName: "5G CPE Ultra 6",
        classify: "cpe",
      },
      network: {
        operatorName: "Example Mobile",
        numericPlmn: "00000",
      },
      signal: {
        nrRsrp: "-95 dBm",
        nrSinr: "18 dB",
      },
      sms: {
        localUnread: 2,
        localInbox: 36,
        localOutbox: 4,
        localMax: 500,
        contactThreads: 8,
      },
    }),
    listContacts: async () => ({
      total: 2,
      page: 1,
      count: 8,
      contacts: [
        {
          index: 41001,
          phone: "0871234567",
          content: "See you at six.",
          date: "2026-10-28 18:00",
          isUnread: true,
          direction: "in",
        },
        {
          index: 41002,
          phone: "0867654321",
          content: "Thanks, received.",
          date: "2026-10-28 16:20",
          isUnread: false,
          direction: "out",
        },
      ],
    }),
  } as never;

  return new TelegramSmsBot({
    token: "123456:FAKE_TOKEN",
    cpePassword: "preview-password",
    cpeClient,
    stateStore,
    fetchImpl: fakeFetch,
  });
}

export async function buildTelegramStylePreviews(): Promise<TelegramStylePreview[]> {
  const calls: CapturedCall[] = [];
  const bot = createPreviewBot(calls);
  const previews: TelegramStylePreview[] = [];

  const capture = async (name: string, action: () => Promise<void>): Promise<void> => {
    await action();
    const payload = calls.filter((call) => call.method === "sendMessage").at(-1)?.payload;
    if (!payload) {
      throw new Error(`Telegram preview did not produce a message for ${name}`);
    }
    previews.push({ name, payload });
  };

  await capture("新短信", () =>
    bot.notifyNewSms({
      index: 41001,
      phone: "0871234567",
      content: "Your verification code is 112233. See you at six.",
      date: "2026-10-28 18:00",
      smstat: "0",
      smstype: "1",
      curbox: "0",
      isUnread: true,
      direction: "in",
    })
  );

  await capture("帮助", async () => {
    await bot.handleUpdate({
      update_id: 2,
      message: { message_id: 2, chat: { id: "preview-chat" }, text: "/help" },
    });
  });

  await capture("状态", async () => {
    await bot.handleUpdate({
      update_id: 3,
      message: { message_id: 3, chat: { id: "preview-chat" }, text: "/status" },
    });
  });

  await capture("最近会话", async () => {
    await bot.handleUpdate({
      update_id: 4,
      message: { message_id: 4, chat: { id: "preview-chat" }, text: "/inbox" },
    });
  });

  await capture("发短信", async () => {
    await bot.handleUpdate({
      update_id: 5,
      message: { message_id: 5, chat: { id: "preview-chat" }, text: "/new" },
    });
  });

  return previews;
}

function plainText(html: string): string {
  return html
    .replace(/<\/?b>|<\/?i>|<\/?code>|<\/?blockquote>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function printPreviews(previews: TelegramStylePreview[]): void {
  for (const [index, preview] of previews.entries()) {
    const text = plainText(String(preview.payload.text ?? ""));
    const markup = preview.payload.reply_markup as InlineKeyboardMarkup | undefined;
    const buttonRows =
      markup?.inline_keyboard?.map((row) => row.map((button) => `[ ${button.text} ]`).join(" ")) ??
      [];

    console.log(`\n${index + 1}. ${preview.name}\n${"-".repeat(36)}`);
    console.log(text);
    if (buttonRows.length > 0) {
      console.log(`\n${buttonRows.join("\n")}`);
    }
  }

  console.log(
    "\n终端预览完成。若要在 Telegram 中查看真实效果，请设置 TELEGRAM_PREVIEW_TOKEN 和 TELEGRAM_PREVIEW_CHAT_ID，然后加 --send。"
  );
}

async function sendPreviews(previews: TelegramStylePreview[]): Promise<void> {
  const token = process.env.TELEGRAM_PREVIEW_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_PREVIEW_CHAT_ID?.trim();
  if (!token || !chatId) {
    throw new Error(
      "发送模式需要 TELEGRAM_PREVIEW_TOKEN 和 TELEGRAM_PREVIEW_CHAT_ID。建议使用独立的测试 Bot。"
    );
  }

  const apiBase = (process.env.TELEGRAM_PREVIEW_API_BASE ?? "https://api.telegram.org").replace(
    /\/+$/,
    ""
  );

  for (const preview of previews) {
    const response = await fetch(`${apiBase}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...preview.payload, chat_id: chatId }),
    });
    const result = (await response.json()) as { ok?: boolean; description?: string };
    if (!response.ok || !result.ok) {
      throw new Error(
        `Telegram 预览发送失败 (${response.status}): ${result.description ?? "unknown error"}`
      );
    }
    console.log(`已发送：${preview.name}`);
  }
}

async function main(): Promise<void> {
  const previews = await buildTelegramStylePreviews();
  if (process.argv.includes("--send")) {
    await sendPreviews(previews);
    return;
  }
  printPreviews(previews);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
