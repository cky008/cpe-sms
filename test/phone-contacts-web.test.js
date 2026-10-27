import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContactStore, parseVcardContacts } from "../src/contacts.js";
import { createHttpApiServer, createWebProxyServer } from "../src/http-server.js";
import {
  canonicalThreadKey,
  extractBrandSignature,
  parseSenderInfo,
  resolveRecipientPhone,
} from "../src/phone.js";
import { SmsArchiveStore } from "../src/sms-archive.js";
import { StateStore } from "../src/state-store.js";
import { TelegramSmsBot } from "../src/telegram-bot.js";

test("resolveRecipientPhone normalizes Irish +353 default, other countries, 00 prefix, and short codes", () => {
  // Irish local number with leading trunk 0
  const ie1 = resolveRecipientPhone("083 123 4567", "+353");
  assert.equal(ie1.ok, true);
  assert.equal(ie1.phone, "+353831234567");
  assert.equal(ie1.flag, "🇮🇪");
  assert.equal(ie1.countryZh, "爱尔兰");

  // Irish local number without leading 0
  const ie2 = resolveRecipientPhone("831234567", "+353");
  assert.equal(ie2.ok, true);
  assert.equal(ie2.phone, "+353831234567");

  // Bare 353... without + avoids doubling +353353...
  const ie3 = resolveRecipientPhone("353831234567", "+353");
  assert.equal(ie3.ok, true);
  assert.equal(ie3.phone, "+353831234567");

  // Explicit international overrides default +353
  const cn1 = resolveRecipientPhone("+86 138-0013-8000", "+353");
  assert.equal(cn1.ok, true);
  assert.equal(cn1.phone, "+8613800138000");
  assert.equal(cn1.flag, "🇨🇳");
  assert.equal(cn1.countryZh, "中国大陆");

  // 00 international prefix -> +
  const uk1 = resolveRecipientPhone("00447911123456", "+353");
  assert.equal(uk1.ok, true);
  assert.equal(uk1.phone, "+447911123456");
  assert.equal(uk1.flag, "🇬🇧");

  // UK selected country drops trunk 0
  const uk2 = resolveRecipientPhone("07911 123456", "+44");
  assert.equal(uk2.ok, true);
  assert.equal(uk2.phone, "+447911123456");

  // China selected country keeps leading digits
  const cn2 = resolveRecipientPhone("13800138000", "+86");
  assert.equal(cn2.ok, true);
  assert.equal(cn2.phone, "+8613800138000");

  // Carrier short code (e.g. 3Ireland 50272)
  const sc = resolveRecipientPhone("50272", "+353");
  assert.equal(sc.ok, true);
  assert.equal(sc.phone, "50272");
  assert.equal(sc.isShortCode, true);

  // Invalid alphabetic string
  const bad = resolveRecipientPhone("not-a-phone", "+353");
  assert.equal(bad.ok, false);
});

test("parseSenderInfo & canonicalThreadKey identify countries, alphanumeric IDs, and brand signatures", () => {
  const alpha = parseSenderInfo("Three", "Your 3Ireland verification code is 482910");
  assert.equal(alpha.type, "alphanumeric");
  assert.equal(alpha.dialable, false);
  assert.equal(alpha.flag, "🏢");

  const gw = parseSenderInfo("1069012345678", "【美团】您的登录验证码为 837492，请勿泄露。");
  assert.equal(gw.type, "gateway");
  assert.equal(gw.countryCode, "+86");
  assert.equal(gw.brandHint, "美团");

  // Bare 13-digit China mobile vs 9-digit Irish Vodafone (086 -> 86xxxxxxx)
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

  // Canonical key merges Irish local 083... and +35383... into identical thread!
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
    // Quoted-Printable UTF-8 for "林小小" (=E6=9E=97=E5=B0=8F=E5=B0=8F) with soft line wrap
    "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E6=9E=97=",
    "=E5=B0=8F=E5=B0=8F",
    "TEL;CELL:0086 139 1234 5678",
    "END:VCARD",
  ].join("\r\n");

  const parsed = parseVcardContacts(sampleIphoneVcf);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "Sean Murphy");
  assert.deepEqual(parsed[0].phones, ["+353835551234"]);
  assert.equal(parsed[1].name, "林小小");

  const store = new ContactStore(contactsFile, "+353");
  const stats = store.importVcard(sampleIphoneVcf);
  assert.equal(stats.added, 2);

  // Cross-format lookup: incoming SMS with local `0835551234` matches `+353835551234`!
  const hitLocal = store.resolvePhone("0835551234");
  assert.equal(hitLocal?.name, "Sean Murphy");

  const hitCn = store.resolvePhone("+8613912345678");
  assert.equal(hitCn?.name, "林小小");

  // Manual remark takes precedence and survives subsequent vCard re-import
  store.upsertManualContact({ phone: "0835551234", name: "房东 Sean" });
  store.importVcard(sampleIphoneVcf);
  assert.equal(store.resolvePhone("+353835551234")?.name, "房东 Sean");

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
        curbox: "0",
        isUnread: false,
        direction: "in",
      },
    ],
  });

  const fakeCpe = {
    async getStatusSummary() {
      return {
        device: { deviceName: "H168-383", marketingName: "5G CPE Ultra 6" },
        network: { operatorName: "3Ireland" },
        signal: { nrRsrp: "-93dBm", nrSinr: "16dB" },
        sms: { localUnread: 1, localInbox: 2, localOutbox: 1, localMax: 500, contactThreads: 2 },
      };
    },
    async sendSms(phones, content) {
      return { ok: true, phones, encoding: "7BIT", segments: 1, failedPhones: [], failCode: "" };
    },
  };

  const webServer = createHttpApiServer({
    cpeClient: /** @type {any} */ (fakeCpe),
    archiveStore,
    contactStore,
    apiToken: "web-secret-pass",
    defaultCountryCode: "+353",
    serveWebUi: true,
  });

  await new Promise((resolve) => webServer.listen(0, "127.0.0.1", resolve));
  const addr = /** @type {import("node:net").AddressInfo} */ (webServer.address());
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Also verify standalone Web Proxy server (`docker compose --profile web`)
  const proxyServer = createWebProxyServer({ upstreamUrl: baseUrl });
  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  const proxyAddr = /** @type {import("node:net").AddressInfo} */ (proxyServer.address());
  const proxyUrl = `http://127.0.0.1:${proxyAddr.port}`;

  try {
    // 1. Static HTML & compiled daisyUI CSS served on both direct & proxy server
    const htmlRes = await fetch(`${proxyUrl}/`);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.match(htmlText, /H168-383 实时短信中心/);

    const cssRes = await fetch(`${proxyUrl}/app.css`);
    assert.equal(cssRes.status, 200);
    const cssText = await cssRes.text();
    assert.match(cssText, /daisyui/);

    // 2. Unauthenticated check returns authenticated: false
    const checkBefore = await fetch(`${proxyUrl}/api/auth/check`).then((r) => r.json());
    assert.equal(checkBefore.authenticated, false);

    // 3. Login sets HttpOnly session cookie
    const loginRes = await fetch(`${proxyUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "web-secret-pass" }),
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /cpe_sms_session=/);
    const cookieHeader = setCookie.split(";")[0];

    // 4. Archive threads merge `0831112222` and `+353831112222` under "Alice Dublin"
    const threadsRes = await fetch(`${proxyUrl}/api/archive/threads`, {
      headers: { Cookie: cookieHeader },
    }).then((r) => r.json());
    assert.equal(threadsRes.ok, true);
    assert.equal(threadsRes.data.archiveTotal, 3);
    assert.equal(threadsRes.data.threads.length, 2);

    const aliceThread = threadsRes.data.threads.find((t) => t.displayName === "Alice Dublin");
    assert.ok(aliceThread);
    assert.equal(aliceThread.totalCount, 2);
    assert.equal(aliceThread.sender.flag, "🇮🇪");

    // OTP filter returns only the Three OTP thread
    const otpThreadsRes = await fetch(`${proxyUrl}/api/archive/threads?filter=otp`, {
      headers: { Cookie: cookieHeader },
    }).then((r) => r.json());
    assert.equal(otpThreadsRes.data.threads.length, 1);
    assert.equal(otpThreadsRes.data.threads[0].latestOtp, "739201");

    // 5. Real-time SSE `/api/events` streams `hello` and live `sms:new` events!
    const sseAbort = new AbortController();
    const sseRes = await fetch(`${baseUrl}/api/events`, {
      headers: { Cookie: cookieHeader },
      signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();

    const firstChunk = decoder.decode((await reader.read()).value);
    assert.match(firstChunk, /event: hello/);

    // Trigger real-time incoming SMS
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
    await new Promise((r) => proxyServer.close(r));
    await new Promise((r) => webServer.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TelegramSmsBot supports Guided Send SMS Wizard (+353 default & country switch) and .vcf import", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-tg-wiz-"));
  const stateStore = new StateStore(path.join(tmpDir, "state.json"));
  stateStore.authorizeChat("99001");
  const contactStore = new ContactStore(path.join(tmpDir, "contacts.json"), "+353");
  const archiveStore = new SmsArchiveStore({
    filePath: path.join(tmpDir, "archive.json"),
    contactStore,
    defaultCountryCode: "+353",
  });

  /** @type {Array<{ method: string, payload: any }>} */
  const tgCalls = [];
  /** @type {Array<{ phone: any, content: string }>} */
  const sentSmsLog = [];

  const fakeCpe = {
    baseUrl: "http://192.168.8.1",
    async sendSms(phone, content) {
      sentSmsLog.push({ phone, content });
      return { ok: true, phones: [phone], encoding: "UCS2", segments: 1, failedPhones: [], failCode: "" };
    },
  };

  const fakeFetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/file/bot")) {
      return new Response(
        [
          "BEGIN:VCARD",
          "VERSION:3.0",
          "FN: Liam O'Connor",
          "TEL:+353 87 999 0000",
          "END:VCARD",
        ].join("\r\n"),
        { status: 200 }
      );
    }
    const method = u.split("/").pop();
    const payload = init.body ? JSON.parse(String(init.body)) : {};
    tgCalls.push({ method, payload });

    if (method === "getFile") {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "documents/contacts.vcf" } }));
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
    cpeClient: /** @type {any} */ (fakeCpe),
    stateStore,
    contactStore,
    archiveStore,
    fetchImpl: fakeFetch,
  });

  // 1. Guided Send SMS Wizard with default Ireland (+353)
  await bot.handleUpdate({
    update_id: 1,
    message: { message_id: 10, chat: { id: 99001 }, text: "/new" },
  });
  assert.match(tgCalls.at(-1).payload.text, /第 1\/2 步.*爱尔兰 \(\+353\)/s);

  // User enters local Irish number `083 777 6666` -> auto-normalized to `+353837776666`
  await bot.handleUpdate({
    update_id: 2,
    message: { message_id: 11, chat: { id: 99001 }, text: "083 777 6666" },
  });
  assert.match(tgCalls.at(-1).payload.text, /第 2\/2 步.*\+353837776666/s);

  // User enters SMS body -> receives confirmation preview
  await bot.handleUpdate({
    update_id: 3,
    message: { message_id: 12, chat: { id: 99001 }, text: "你好，快递到了吗？" },
  });
  assert.match(tgCalls.at(-1).payload.text, /确认预览.*UCS2/s);

  // User taps "🚀 确认立即发送" (`wizsend:1`)
  await bot.handleUpdate({
    update_id: 4,
    callback_query: {
      id: "cq-1",
      data: "wizsend:1",
      message: { message_id: 503, chat: { id: 99001 } },
    },
  });
  assert.equal(sentSmsLog.length, 1);
  assert.equal(sentSmsLog[0].phone, "+353837776666");
  assert.equal(sentSmsLog[0].content, "你好，快递到了吗？");
  assert.equal(archiveStore.messages.size, 1);

  // 2. Upload iPhone `.vcf` directly in Telegram chat -> enriches subsequent incoming SMS!
  await bot.handleUpdate({
    update_id: 5,
    message: {
      message_id: 13,
      chat: { id: 99001 },
      document: { file_id: "file-vcf-1", file_name: "iPhone_Contacts.vcf", mime_type: "text/vcard" },
    },
  });
  assert.match(tgCalls.at(-1).payload.text, /通讯录导入成功/);
  assert.equal(contactStore.resolvePhone("0879990000")?.name, "Liam O'Connor");

  // Incoming SMS from local Irish `0879990000` shows both Contact Name AND `🇮🇪 爱尔兰 (+353)`!
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
  const pushHtml = tgCalls.at(-1).payload.text;
  assert.match(pushHtml, /Liam O'Connor/);
  assert.match(pushHtml, /🇮🇪.*爱尔兰 \(\+353\)/);
  assert.match(pushHtml, /112233/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
