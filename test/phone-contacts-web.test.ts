import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContactStore, parseVcardContacts } from "../src/contacts.ts";
import { createHttpApiServer, createWebProxyServer } from "../src/http-server.ts";
import {
  canonicalThreadKey,
  extractBrandSignature,
  parseSenderInfo,
  resolveRecipientPhone,
} from "../src/phone.ts";
import { SmsArchiveStore } from "../src/sms-archive.ts";
import { StateStore } from "../src/state-store.ts";
import { TelegramSmsBot } from "../src/telegram-bot.ts";

test("resolveRecipientPhone normalizes Irish +353 default, other countries, 00 prefix, and short codes", () => {
  const ie1 = resolveRecipientPhone("083 123 4567", "+353");
  assert.equal(ie1.ok, true);
  if (ie1.ok) {
    assert.equal(ie1.phone, "+353831234567");
    assert.equal(ie1.flag, "🇮🇪");
    assert.equal(ie1.countryZh, "爱尔兰");
  }

  const ie2 = resolveRecipientPhone("831234567", "+353");
  assert.equal(ie2.ok && ie2.phone, "+353831234567");

  const ie3 = resolveRecipientPhone("353831234567", "+353");
  assert.equal(ie3.ok && ie3.phone, "+353831234567");

  const cn1 = resolveRecipientPhone("+86 138-0013-8000", "+353");
  assert.equal(cn1.ok && cn1.phone, "+8613800138000");

  const uk1 = resolveRecipientPhone("00447911123456", "+353");
  assert.equal(uk1.ok && uk1.phone, "+447911123456");

  const uk2 = resolveRecipientPhone("07911 123456", "+44");
  assert.equal(uk2.ok && uk2.phone, "+447911123456");

  const cn2 = resolveRecipientPhone("13800138000", "+86");
  assert.equal(cn2.ok && cn2.phone, "+8613800138000");

  const sc = resolveRecipientPhone("50272", "+353");
  assert.equal(sc.ok && sc.isShortCode, true);

  assert.equal(resolveRecipientPhone("", "+353").ok, false);
  assert.equal(resolveRecipientPhone("not-a-phone", "+353").ok, false);
});

test("parseSenderInfo & canonicalThreadKey identify countries, alphanumeric IDs, and brand signatures", () => {
  assert.equal(parseSenderInfo("").type, "unknown");

  const alpha = parseSenderInfo("Three", "Your 3Ireland verification code is 482910");
  assert.equal(alpha.type, "alphanumeric");
  assert.equal(alpha.dialable, false);
  assert.equal(alpha.flag, "🏢");

  const gw = parseSenderInfo("1069012345678", "【美团】您的登录验证码为 837492，请勿泄露。");
  assert.equal(gw.type, "gateway");
  assert.equal(gw.countryCode, "+86");
  assert.equal(gw.brandHint, "美团");

  const bareCn = parseSenderInfo("8613800138000", "", "+353");
  assert.equal(bareCn.e164, "+8613800138000");
  assert.equal(bareCn.countryIso, "CN");

  const irish086 = parseSenderInfo("861234567", "", "+353");
  assert.equal(irish086.e164, "+353861234567");
  assert.equal(irish086.countryIso, "IE");

  const shortThree = parseSenderInfo("3", "Welcome to Three", "+353");
  assert.equal(shortThree.type, "shortcode");

  assert.equal(extractBrandSignature("Your code is 123456【Apple】"), "Apple");
  assert.equal(extractBrandSignature("[GitHub] 998877 is your authentication code"), "GitHub");
  assert.equal(extractBrandSignature("Google: G-123456 is your code"), "Google");

  assert.equal(
    canonicalThreadKey("083 123 4567", "+353"),
    canonicalThreadKey("+353831234567", "+353")
  );
  assert.equal(canonicalThreadKey("Three", "+353"), "alpha:three");
});

test("parseVcardContacts & ContactStore handle iPhone .vcf (item1.TEL, folded lines, Quoted-Printable UTF-8)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-contacts-"));
  const contactsFile = path.join(tmpDir, "contacts.json");

  const sampleIphoneVcf = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "PRODID:-//Apple Inc.//iPhone OS 18.1//EN",
    "N:Murphy;Sean;;;",
    "FN:Sean Murphy",
    "ORG:Dublin Property;",
    "item1.TEL;type=CELL;type=VOICE;type=pref:+353 83 555 1234",
    "item1.X-ABLabel:_$!<Mobile>!$_",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:2.1",
    "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E6=9E=97=",
    "=E5=B0=8F=E5=B0=8F",
    "TEL;CELL:0086 139 1234 5678",
    "END:VCARD",
  ].join("\r\n");

  const parsed = parseVcardContacts(sampleIphoneVcf);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.name, "Sean Murphy");
  assert.deepEqual(parsed[0]?.phones, ["+353835551234"]);
  assert.equal(parsed[1]?.name, "林小小");

  const store = new ContactStore(contactsFile, "+353");
  const stats = store.importVcard(sampleIphoneVcf);
  assert.equal(stats.added, 2);

  assert.equal(store.resolvePhone("0835551234")?.name, "Sean Murphy");
  assert.equal(store.resolvePhone("+8613912345678")?.name, "林小小");

  store.upsertManualContact({ phone: "0835551234", name: "房东 Sean" });
  store.importVcard(sampleIphoneVcf);
  assert.equal(store.resolvePhone("+353835551234")?.name, "房东 Sean");

  assert.equal(store.search("房东").length, 1);
  const idToDelete = store.contacts[0]!.id;
  assert.equal(store.deleteContact(idToDelete), true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("daisyUI Web Server serves assets, authenticates cookie, queries historical archive, and streams SSE", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-webui-"));
  const contactStore = new ContactStore(path.join(tmpDir, "contacts.json"), "+353");
  contactStore.upsertManualContact({ phone: "+353831112222", name: "Alice Dublin" });

  const archiveStore = new SmsArchiveStore({
    filePath: path.join(tmpDir, "archive.json"),
    contactStore,
    defaultCountryCode: "+353",
  });

  archiveStore.ingestFullDump({
    localUnread: 1,
    localInbox: 2,
    localOutbox: 1,
    localMax: 500,
    messages: [
      {
        index: 40001,
        phone: "0831112222",
        content: "Hi! Are you home?",
        date: "2026-10-27 12:00:00",
        smstat: "0",
        smstype: "1",
        curbox: "0",
        isUnread: true,
        direction: "in",
      },
      {
        index: 40002,
        phone: "+353831112222",
        content: "Yes, come on up!",
        date: "2026-10-27 12:02:00",
        smstat: "3",
        smstype: "1",
        curbox: "1",
        isUnread: false,
        direction: "out",
      },
      {
        index: 40003,
        phone: "Three",
        content: "Your Three verification code is 739201.",
        date: "2026-10-27 12:05:00",
        smstat: "1",
        smstype: "1",
        curbox: "0",
        isUnread: false,
        direction: "in",
      },
    ],
  });

  const fakeCpe = {
    async getStatusSummary() {
      return {
        device: { deviceName: "H168-383", marketingName: "5G CPE Ultra 6", classify: "cpe" },
        network: { operatorName: "3Ireland", numericPlmn: "27205", connectionStatus: "901", currentNetworkTypeEx: "", signalIcon: "" },
        signal: { mode: "", rsrp: "", sinr: "", nrRsrp: "-93dBm", nrSinr: "16dB", band: "" },
        sms: { localUnread: 1, localInbox: 2, localOutbox: 1, localDraft: 0, localMax: 500, contactThreads: 2, storageFull: false },
      };
    },
    async sendSms(phones: string[]) {
      return { ok: true, submitted: true, sentPhones: phones, failedPhones: [], failCode: null, encoding: "7BIT" as const, segments: 1 };
    },
    async deleteSms() {
      return { count: 1 };
    },
  };

  const webServer = createHttpApiServer({
    cpeClient: fakeCpe as never,
    archiveStore,
    contactStore,
    apiToken: "web-secret-pass",
    defaultCountryCode: "+353",
    serveWebUi: true,
  });

  await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;

  const proxyServer = createWebProxyServer({ upstreamUrl: baseUrl });
  await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}`;

  try {
    const htmlRes = await fetch(`${proxyUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /H168-383 实时短信中心/);

    const cssRes = await fetch(`${proxyUrl}/app.css`);
    assert.equal(cssRes.status, 200);
    assert.match(await cssRes.text(), /daisyui/);

    const checkBefore = (await fetch(`${proxyUrl}/api/auth/check`).then((r) => r.json())) as {
      authenticated: boolean;
    };
    assert.equal(checkBefore.authenticated, false);

    const loginRes = await fetch(`${proxyUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "web-secret-pass" }),
    });
    assert.equal(loginRes.status, 200);
    const cookieHeader = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]!;

    const threadsRes = (await fetch(`${proxyUrl}/api/archive/threads`, {
      headers: { Cookie: cookieHeader },
    }).then((r) => r.json())) as {
      ok: boolean;
      data: { archiveTotal: number; threads: unknown[] };
    };
    assert.equal(threadsRes.ok, true);
    assert.equal(threadsRes.data.archiveTotal, 3);
    assert.equal(threadsRes.data.threads.length, 2);

    const detailRes = (await fetch(
      `${proxyUrl}/api/archive/thread?key=${encodeURIComponent("+353831112222")}`,
      { headers: { Cookie: cookieHeader } }
    ).then((r) => r.json())) as { data: { messages: unknown[] } };
    assert.equal(detailRes.data.messages.length, 2);

    const previewRes = (await fetch(`${proxyUrl}/api/sms/preview`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "0831234567", countryCode: "+353", content: "Hello" }),
    }).then((r) => r.json())) as { data: { recipient: { phone: string } } };
    assert.equal(previewRes.data.recipient.phone, "+353831234567");

    // Contacts API CRUD & vCard import
    const vcfRes = (await fetch(`${proxyUrl}/api/contacts/import-vcf`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ vcf: "BEGIN:VCARD\nFN:Bob\nTEL:0851112222\nEND:VCARD" }),
    }).then((r) => r.json())) as { data: { added: number } };
    assert.equal(vcfRes.data.added, 1);

    const bookRes = (await fetch(`${proxyUrl}/api/contacts/book`, {
      headers: { Cookie: cookieHeader },
    }).then((r) => r.json())) as { data: { total: number } };
    assert.equal(bookRes.data.total, 2);

    // Real-time SSE `/api/events`
    const sseAbort = new AbortController();
    const sseRes = await fetch(`${baseUrl}/api/events`, {
      headers: { Cookie: cookieHeader },
      signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    const firstChunk = decoder.decode((await reader.read()).value);
    assert.match(firstChunk, /event: hello/);

    archiveStore.recordRealtimeMessage(
      {
        index: 40004,
        phone: "+8613800138000",
        content: "【中国银行】验证码 654321",
        date: "2026-10-27 12:10:00",
        smstat: "0",
        isUnread: true,
        direction: "in",
      },
      "sms:new"
    );

    const secondChunk = decoder.decode((await reader.read()).value);
    assert.match(secondChunk, /event: sms:new/);
    assert.match(secondChunk, /654321/);
    sseAbort.abort();
  } finally {
    await new Promise<void>((r) => proxyServer.close(() => r()));
    await new Promise<void>((r) => webServer.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TelegramSmsBot supports /auth, Guided Send SMS Wizard (+353 & country switch), commands, reply-to-send, and .vcf import", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-tg-wiz-"));
  const stateStore = new StateStore(path.join(tmpDir, "state.json"));
  const contactStore = new ContactStore(path.join(tmpDir, "contacts.json"), "+353");
  const archiveStore = new SmsArchiveStore({
    filePath: path.join(tmpDir, "archive.json"),
    contactStore,
    defaultCountryCode: "+353",
  });

  const tgCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const sentSmsLog: Array<{ phone: string | string[]; content: string }> = [];

  const fakeCpe = {
    baseUrl: "http://192.168.8.1",
    async getStatusSummary() {
      return {
        device: { deviceName: "H168-383", marketingName: "5G CPE Ultra 6", classify: "cpe" },
        network: { operatorName: "3Ireland", numericPlmn: "27205", connectionStatus: "901", currentNetworkTypeEx: "", signalIcon: "" },
        signal: { mode: "", rsrp: "", sinr: "", nrRsrp: "-94dBm", nrSinr: "15dB", band: "" },
        sms: { localUnread: 1, localInbox: 2, localOutbox: 0, localDraft: 0, localMax: 500, contactThreads: 1, storageFull: false },
      };
    },
    async listContacts() {
      return {
        total: 1,
        page: 1,
        count: 8,
        contacts: [
          {
            index: 40001,
            phone: "0879990000",
            content: "Hello!",
            date: "2026-10-27 18:00:00",
            smstat: "0",
            smstype: "1",
            curbox: "0",
            isUnread: true,
            direction: "in" as const,
          },
        ],
      };
    },
    async fetchRecentInboxMessages() {
      return {
        localUnread: 1,
        localInbox: 1,
        localMax: 500,
        messages: [
          {
            index: 40001,
            phone: "0879990000",
            content: "OTP code is 445566",
            date: "2026-10-27 18:00:00",
            smstat: "0",
            smstype: "1",
            curbox: "0",
            isUnread: true,
            direction: "in" as const,
          },
        ],
      };
    },
    async listPhoneMessages(phone: string) {
      return {
        phone,
        total: 1,
        page: 1,
        count: 12,
        messages: [
          {
            index: 40001,
            phone,
            content: "Hi there",
            date: "2026-10-27 18:00:00",
            smstat: "0",
            smstype: "1",
            curbox: "0",
            isUnread: true,
            direction: "in" as const,
          },
        ],
      };
    },
    async markRead() {
      return { count: 1 };
    },
    async deleteSms() {
      return { count: 1 };
    },
    async sendSms(phone: string | string[], content: string) {
      sentSmsLog.push({ phone, content });
      return {
        ok: true,
        submitted: true,
        sentPhones: Array.isArray(phone) ? phone : [phone],
        failedPhones: [],
        failCode: null,
        encoding: "UCS2" as const,
        segments: 1,
      };
    },
  };

  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const u = String(input);
    if (u.includes("/file/bot")) {
      return new Response(
        ["BEGIN:VCARD", "VERSION:3.0", "FN: Liam O'Connor", "TEL:+353 87 999 0000", "END:VCARD"].join(
          "\r\n"
        ),
        { status: 200 }
      );
    }
    const method = u.split("/").pop() ?? "";
    const payload = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    tgCalls.push({ method, payload });

    if (method === "getFile") {
      return new Response(
        JSON.stringify({ ok: true, result: { file_path: "documents/contacts.vcf" } })
      );
    }
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 500 + tgCalls.length } }),
      { status: 200 }
    );
  };

  const bot = new TelegramSmsBot({
    token: "123456:FAKE_TOKEN",
    defaultCountryCode: "+353",
    cpePassword: "secret",
    cpeClient: fakeCpe as never,
    stateStore,
    contactStore,
    archiveStore,
    fetchImpl: fakeFetch,
  });

  // 0. Unauthorized chat blocked -> then `/auth secret` pairs and auto-deletes password message
  await bot.handleUpdate({
    update_id: 1,
    message: { message_id: 1, chat: { id: 99001 }, text: "/inbox" },
  });
  assert.match(String(tgCalls.at(-1)?.payload.text), /尚未授权/);

  await bot.handleUpdate({
    update_id: 2,
    message: { message_id: 2, chat: { id: 99001 }, text: "/auth secret" },
  });
  assert.equal(stateStore.isChatAuthorized("99001"), true);
  assert.equal(tgCalls.some((c) => c.method === "deleteMessage"), true);

  // 1. Guided Send SMS Wizard with default Ireland (+353) & country switch (`wizcc:+86` -> `+353`)
  await bot.handleUpdate({
    update_id: 3,
    message: { message_id: 10, chat: { id: 99001 }, text: "/new" },
  });
  assert.match(String(tgCalls.at(-1)?.payload.text), /第 1 步：选择收件人.*爱尔兰 \(\+353\)/s);

  await bot.handleUpdate({
    update_id: 4,
    callback_query: {
      id: "cq-cc",
      data: "wizcc:+86",
      message: { message_id: 505, chat: { id: 99001 } },
    },
  });
  await bot.handleUpdate({
    update_id: 5,
    callback_query: {
      id: "cq-cc2",
      data: "wizcc:+353",
      message: { message_id: 505, chat: { id: 99001 } },
    },
  });

  await bot.handleUpdate({
    update_id: 6,
    message: { message_id: 11, chat: { id: 99001 }, text: "083 777 6666" },
  });
  assert.match(String(tgCalls.at(-1)?.payload.text), /第 2 步：输入正文.*\+353837776666/s);

  await bot.handleUpdate({
    update_id: 7,
    message: { message_id: 12, chat: { id: 99001 }, text: "你好，快递到了吗？" },
  });
  assert.match(String(tgCalls.at(-1)?.payload.text), /确认发送.*UCS2/s);

  await bot.handleUpdate({
    update_id: 8,
    callback_query: {
      id: "cq-1",
      data: "wizsend:1",
      message: { message_id: 509, chat: { id: 99001 } },
    },
  });
  assert.equal(sentSmsLog.length, 1);
  assert.equal(sentSmsLog[0]?.phone, "+353837776666");

  // 2. Upload iPhone `.vcf` directly in Telegram chat
  await bot.handleUpdate({
    update_id: 9,
    message: {
      message_id: 13,
      chat: { id: 99001 },
      document: {
        file_id: "file-vcf-1",
        file_name: "iPhone_Contacts.vcf",
        mime_type: "text/vcard",
      },
    },
  });
  assert.match(String(tgCalls.at(-1)?.payload.text), /通讯录已导入/);

  // 3. Commands: /help, /inbox, /unread, /chat, /contacts, /contact, /read, /delete
  for (const [idx, cmdText] of [
    "/help",
    "/inbox",
    "/unread",
    "/chat 0879990000",
    "/contact 0851234567 快递小哥",
    "/contacts",
    "/read 40001",
    "/delete 40001",
  ].entries()) {
    await bot.handleUpdate({
      update_id: 20 + idx,
      message: { message_id: 30 + idx, chat: { id: 99001 }, text: cmdText },
    });
  }

  // 4. Incoming SMS notification + Native Reply-to-Message!
  await bot.notifyNewSms({
    index: 40999,
    phone: "0879990000",
    content: "See you at 6pm! Code 112233",
    date: "2026-10-27 18:00:00",
    smstat: "0",
    smstype: "1",
    curbox: "0",
    isUnread: true,
    direction: "in",
  });
  const notifyMsgId = 500 + tgCalls.length;
  const pushHtml = String(tgCalls.at(-1)?.payload.text);
  assert.match(pushHtml, /Liam O'Connor/);
  assert.match(pushHtml, /爱尔兰 \(\+353\).*\+353879990000/);

  await bot.handleUpdate({
    update_id: 50,
    message: {
      message_id: 90,
      chat: { id: 99001 },
      reply_to_message: { message_id: notifyMsgId },
      text: "On my way!",
    },
  });
  assert.equal(sentSmsLog.length, 2);
  assert.equal(sentSmsLog[1]?.phone, "+353879990000");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
