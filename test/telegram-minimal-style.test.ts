import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTelegramStylePreviews } from "../scripts/telegram-style-preview.ts";
import { StateStore } from "../src/state-store.ts";
import { TelegramSmsBot } from "../src/telegram-bot.ts";

const TELEGRAM_BOT_PATH = path.join(process.cwd(), "src", "telegram-bot.ts");
const EMOJI_PATTERN = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu;

interface CapturedCall {
  method: string;
  payload: Record<string, unknown>;
}

function createBot(
  calls: CapturedCall[],
  stateStore: StateStore
): TelegramSmsBot {
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const method = String(input).split("/").pop() ?? "";
    const payload = init.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    calls.push({ method, payload });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return new TelegramSmsBot({
    token: "123456:FAKE_TOKEN",
    cpePassword: "test-password",
    cpeClient: {} as never,
    stateStore,
    fetchImpl: fakeFetch,
  });
}

test("Telegram presentation avoids decorative emoji", () => {
  const source = fs.readFileSync(TELEGRAM_BOT_PATH, "utf8");
  const matches = source.match(EMOJI_PATTERN) ?? [];
  assert.deepEqual(
    matches,
    [],
    `Telegram copy still contains decorative emoji: ${matches.join(" ")}`
  );
  assert.doesNotMatch(source, /引导式|发送向导/);
});

test("Telegram notification and help use the minimal typographic hierarchy", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-telegram-style-"));
  const stateStore = new StateStore(path.join(tempDir, "state.json"));
  stateStore.authorizeChat("99001");
  const calls: CapturedCall[] = [];
  const bot = createBot(calls, stateStore);

  try {
    await bot.notifyNewSms({
      index: 41001,
      phone: "0879990000",
      content: "See you at 6pm! Code 112233",
      date: "2026-10-28 18:00:00",
      smstat: "0",
      smstype: "1",
      curbox: "0",
      isUnread: true,
      direction: "in",
    });

    const notificationPayload = calls.at(-1)?.payload;
    const notificationText = String(notificationPayload?.text ?? "");
    assert.match(notificationText, /^<b>新短信<\/b>/);
    assert.match(
      notificationText,
      /<blockquote>See you at 6pm! Code 112233<\/blockquote>/
    );
    assert.match(notificationText, /<b>验证码<\/b>\n<code>112233<\/code>/);
    assert.doesNotMatch(notificationText, EMOJI_PATTERN);

    const replyMarkup = notificationPayload?.reply_markup as {
      inline_keyboard?: Array<Array<{ text: string }>>;
    };
    assert.deepEqual(
      replyMarkup.inline_keyboard?.[0]?.map((button) => button.text),
      ["标为已读", "查看对话", "删除"]
    );

    await bot.handleUpdate({
      update_id: 2,
      message: { message_id: 2, chat: { id: 99001 }, text: "/help" },
    });

    const helpPayload = calls.at(-1)?.payload;
    const helpText = String(helpPayload?.text ?? "");
    assert.match(helpText, /<b>短信助手<\/b>/);
    assert.match(helpText, /<b>常用操作<\/b>/);
    assert.match(helpText, /\/new/);
    assert.doesNotMatch(helpText, EMOJI_PATTERN);

    await bot.handleUpdate({
      update_id: 3,
      message: { message_id: 3, chat: { id: 99001 }, text: "/new" },
    });

    const wizardText = String(calls.at(-1)?.payload.text ?? "");
    assert.match(wizardText, /^<b>发短信<\/b>/);
    assert.match(wizardText, /<b>第 1 步：选择收件人<\/b>/);
    assert.match(wizardText, /<b>当前国家：<\/b>爱尔兰 \(\+353\)/);
    assert.doesNotMatch(wizardText, EMOJI_PATTERN);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Telegram style preview produces a deterministic, CPE-free sample set", async () => {
  const previews = await buildTelegramStylePreviews();
  assert.deepEqual(
    previews.map((preview) => preview.name),
    ["新短信", "帮助", "状态", "最近会话", "发短信"]
  );

  for (const preview of previews) {
    assert.equal(preview.payload.parse_mode, "HTML");
    assert.equal(typeof preview.payload.text, "string");
    assert.doesNotMatch(String(preview.payload.text), EMOJI_PATTERN);
  }

  assert.deepEqual(
    previews[0]?.payload.reply_markup &&
      (
        previews[0].payload.reply_markup as {
          inline_keyboard?: Array<Array<{ text: string }>>;
        }
      ).inline_keyboard?.[0]?.map((button) => button.text),
    ["标为已读", "查看对话", "删除"]
  );
});
