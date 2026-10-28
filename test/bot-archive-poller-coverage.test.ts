import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContactStore } from "../src/contacts.ts";
import type { HuaweiCpeClient } from "../src/cpe-client.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { createHttpApiServer } from "../src/http-server.ts";
import { SmsPoller } from "../src/poller.ts";
import { SmsArchiveStore } from "../src/sms-archive.ts";
import { StateStore } from "../src/state-store.ts";
import { TelegramSmsBot } from "../src/telegram-bot.ts";
import type { CpeFullDump, SmsMessage } from "../src/types.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cpe-sms-cov-"));
}

function createFakeCpeClient(overrides: Partial<HuaweiCpeClient> = {}): HuaweiCpeClient {
  const sampleMsg: SmsMessage = {
    index: 40101,
    phone: "+353831234567",
    content: "【AIB】Your verification code is 739182",
    date: "2026-10-28 12:00:00",
    smstat: "0",
    smstype: "0",
    curbox: "1",
    isUnread: true,
    direction: "in",
    verificationCode: "739182",
  };

  const dump: CpeFullDump = {
    messages: [
      sampleMsg,
      {
        index: 40102,
        phone: "Three",
        content: "Welcome to 5G network",
        date: "2026-10-28 12:05:00",
        smstat: "1",
        smstype: "0",
        curbox: "1",
        isUnread: false,
        direction: "in",
      },
    ],
    localUnread: 1,
    localInbox: 18,
    localOutbox: 2,
    localMax: 500,
  };

  return {
    baseUrl: "http://192.168.8.1",
    checkNotifications: async () => ({
      unreadMessages: 1,
      smsStorageFull: false,
      onlineUpdateStatus: "10",
    }),
    getStatusSummary: async () => ({
      device: {
        deviceName: "H168-383",
        marketingName: "5G CPE Ultra 6",
        softwareVersion: "5.0.0.1",
        hardwareVersion: "WL1H168M",
        serialNumber: "",
        wanIpAddress: "",
      },
      network: {
        state: "registered",
        fullName: "Three Ireland",
        shortName: "3",
        numericPlmn: "27205",
        rat: "7",
        operatorName: "Three Ireland",
      },
      signal: {
        rsrp: "-84dBm",
        rsrq: "-8dB",
        sinr: "18dB",
        rssi: "-60dBm",
        nrRsrp: "-79dBm",
        nrRsrq: "-9dB",
        nrSinr: "24dB",
        band: "78",
        cellId: "12345",
      },
      sms: {
        localUnread: 1,
        localInbox: 18,
        localOutbox: 2,
        localDraft: 0,
        localMax: 500,
        simUnread: 0,
        simUsed: 0,
        simMax: 50,
        newMsg: false,
        contactThreads: 2,
      },
    }),
    listContacts: async () => ({
      total: 2,
      contacts: [
        {
          index: 40101,
          phone: "+353831234567",
          content: sampleMsg.content,
          date: sampleMsg.date,
          smstat: "0",
          curbox: "1",
          totalCount: 3,
          unreadCount: 1,
          isUnread: true,
          direction: "in" as const,
        },
        {
          index: 40102,
          phone: "Three",
          content: "Welcome to 5G network",
          date: "2026-10-28 12:05:00",
          smstat: "1",
          curbox: "1",
          totalCount: 1,
          unreadCount: 0,
          isUnread: false,
          direction: "in" as const,
        },
      ],
    }),
    listPhoneMessages: async (phone: string) => ({
      total: phone === "empty" ? 0 : 1,
      messages: phone === "empty" ? [] : [sampleMsg],
    }),
    fetchRecentInboxMessages: async () => ({
      localUnread: 1,
      localInbox: 18,
      localMax: 500,
      messages: [sampleMsg],
    }),
    fetchAllMessages: async () => dump,
    sendSms: async () => ({
      ok: true,
      encoding: "GSM-7BIT" as const,
      segments: 1,
      length: 12,
      failCode: "",
    }),
    markRead: async (ids: Array<string | number>) => ({ ok: true, count: ids.length }),
    deleteSms: async (ids: Array<string | number>) => ({ ok: true, count: ids.length }),
    ...overrides,
  } as unknown as HuaweiCpeClient;
}

test("TelegramSmsBot covers commands, callbacks, notifications, rate-limit, and alphanumeric reply guard", async () => {
  const dir = makeTempDir();
  const cipher = new StorageCipher("bot-cov-key");
  const stateStore = new StateStore(path.join(dir, "state.json"), cipher);
  const contactStore = new ContactStore(path.join(dir, "contacts.json"), "+353", cipher);
  const archiveStore = new SmsArchiveStore({
    filePath: path.join(dir, "archive.json"),
    contactStore,
    defaultCountryCode: "+353",
    cipher,
  });

  const cpeClient = createFakeCpeClient();
  const poller = new SmsPoller({ cpeClient, stateStore, archiveStore });
  await poller.syncFullHistory({ isInitial: true });

  const tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let nextMsgId = 500;

  const bot = new TelegramSmsBot({
    token: "123456:FAKE_TOKEN",
    cpePassword: "correct-password",
    defaultCountryCode: "+353",
    stateStore,
    contactStore,
    archiveStore,
    cpeClient,
    poller,
    fetchImpl: async (url, init) => {
      const u = String(url);
      const method = u.split("/").pop() ?? "";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      tgCalls.push({ method, body });
      nextMsgId += 1;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: nextMsgId, text: body.text ?? "" } }),
        { status: 200 }
      );
    },
  });

  try {
    // 1. Unauthorized message & unauthorized callback query + 5 failed /auth attempts -> rate limit
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 777 }, text: "/status" } });
    await bot.handleUpdate({
      update_id: 2,
      callback_query: { id: "cq-unauth", message: { message_id: 2, chat: { id: 777 } }, data: "status:1" },
    });
    await bot.handleUpdate({ update_id: 3, message: { message_id: 3, chat: { id: 777 }, text: "/auth" } });
    for (let i = 0; i < 5; i++) {
      await bot.handleUpdate({
        update_id: 10 + i,
        message: { message_id: 10 + i, chat: { id: 777 }, text: "/auth wrong" },
      });
    }
    await bot.handleUpdate({
      update_id: 20,
      message: { message_id: 20, chat: { id: 777 }, text: "/auth correct-password" },
    });
    assert.equal(stateStore.isChatAuthorized("777"), false);

    // 2. Authorize chat 888 and test duplicate /auth
    await bot.handleUpdate({
      update_id: 30,
      message: { message_id: 30, chat: { id: 888 }, text: "/auth correct-password" },
    });
    assert.equal(stateStore.isChatAuthorized("888"), true);
    await bot.handleUpdate({
      update_id: 31,
      message: { message_id: 31, chat: { id: 888 }, text: "/auth correct-password" },
    });

    // 3. Notifications: notifyNewSms & notifyStorageWarning
    await bot.notifyNewSms({
      index: 40200,
      phone: "Three",
      content: "Service notice: code 918273",
      date: "2026-10-28 13:00:00",
      smstat: "0",
      smstype: "0",
      curbox: "1",
      isUnread: true,
      direction: "in",
    });
    const alphaMsgId = nextMsgId;
    // Replying to alphanumeric sender ("Three") warns that it's non-dialable
    await bot.handleUpdate({
      update_id: 32,
      message: {
        message_id: 32,
        chat: { id: 888 },
        reply_to_message: { message_id: alphaMsgId },
        text: "Stop",
      },
    });

    await bot.notifyStorageWarning({ localInbox: 495, localMax: 500, storageFull: false });
    await bot.notifyStorageWarning({ localInbox: 500, localMax: 500, storageFull: true });

    // 4. All slash commands
    const commands = [
      "/help",
      "/status",
      "/inbox",
      "/unread",
      "/chat",
      "/chat empty",
      "/chat +353831234567",
      "/contact",
      "/contact 0839998888 Landlord John",
      "/contacts",
      "/contacts John",
      "/contacts NonExistent",
      "/send",
      "/cancel",
      "/cancel",
      "/send invalid!!! hi",
      "/send 0839998888 Rent paid!",
      "/read",
      "/read 40101",
      "/read all",
      "/delete",
      "/delete 40101",
      "/sync",
      "/unknowncmd",
      "plain message without slash",
    ];
    let uid = 100;
    for (const cmd of commands) {
      uid += 1;
      await bot.handleUpdate({
        update_id: uid,
        message: { message_id: uid, chat: { id: 888 }, text: cmd },
      });
    }

    // 5. All inline callback actions
    const callbacks = [
      "wizstart:1",
      "wizpick:+353839998888",
      "wizback:phone",
      "wizcancel:1",
      "wizsend:1", // expired wizard alert
      "read:40101",
      "readall:1",
      "del:40101",
      "chat:+353831234567",
      "inbox:1",
      "unread:1",
      "status:1",
      "noop:1",
    ];
    for (const data of callbacks) {
      uid += 1;
      await bot.handleUpdate({
        update_id: uid,
        callback_query: {
          id: `cq-${uid}`,
          message: { message_id: 505, chat: { id: 888 } },
          data,
        },
      });
    }

    assert.ok(tgCalls.length > 35);
    assert.equal(contactStore.contacts.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SmsArchiveStore filters, SmsPoller autoMarkRead/storage_warning/webhook, and HTTP CRUD routes", async () => {
  const dir = makeTempDir();
  const cipher = new StorageCipher("archive-poller-http-key");
  const stateStore = new StateStore(path.join(dir, "state.json"), cipher);
  stateStore.completeSeed([40100], 0);
  const contactStore = new ContactStore(path.join(dir, "contacts.json"), "+353", cipher);
  const archiveStore = new SmsArchiveStore({
    filePath: path.join(dir, "archive.json"),
    contactStore,
    defaultCountryCode: "+353",
    cipher,
  });

  let markedReadIds: Array<string | number> = [];
  let webhookCalls = 0;

  const cpeClient = createFakeCpeClient({
    checkNotifications: async () => ({
      unreadMessages: 2, // increased from 1 -> triggers syncOnce() on tick()
      smsStorageFull: false,
      onlineUpdateStatus: "10",
    }),
    fetchRecentInboxMessages: async () => ({
      localUnread: 1,
      localInbox: 480, // >= 92% of 500 -> triggers storage_warning
      localMax: 500,
      messages: [
        {
          index: 40105,
          phone: "+353831234567",
          content: "【Revolut】Code 556677",
          date: "2026-10-28 14:00:00",
          smstat: "0",
          smstype: "0",
          curbox: "1",
          isUnread: true,
          direction: "in",
        },
      ],
    }),
    markRead: async (ids) => {
      markedReadIds = ids;
      return { ok: true, count: ids.length };
    },
  });

  const poller = new SmsPoller({
    cpeClient,
    stateStore,
    archiveStore,
    pollIntervalMs: 60000,
    autoMarkRead: true,
    webhookUrl: "http://127.0.0.1:9/webhook",
    fetchImpl: async () => {
      webhookCalls += 1;
      return new Response("ok", { status: 200 });
    },
  });

  let storageWarned = false;
  poller.on("storage_warning", () => {
    storageWarned = true;
  });

  await poller.start();
  await poller.tick();
  poller.stop();

  assert.equal(storageWarned, true);
  assert.deepEqual(markedReadIds, [40105]);
  assert.equal(webhookCalls, 1);

  // Archive filters & delete operations (40101 from initial dump remains unread; 40105 was autoMarkedRead)
  assert.equal(archiveStore.listThreads({ filter: "otp" }).length, 1);
  assert.equal(archiveStore.listThreads({ filter: "unread" }).length, 1);
  assert.equal(archiveStore.listThreads({ search: "556677" }).length, 1);

  // Exercise remaining HTTP routes: manual contact CRUD, archive sync, delete, favicon, logout, 400, 404
  const server = createHttpApiServer({
    cpeClient,
    poller,
    archiveStore,
    contactStore,
    apiToken: "route-secret",
    serveWebUi: true,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: "Bearer route-secret",
    "Content-Type": "application/json",
  };

  try {
    assert.equal((await fetch(`${base}/favicon.svg`)).status, 200);
    assert.equal((await fetch(`${base}/nonexistent-page`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/api/unknown`, { headers })).status, 404);
    assert.equal(
      (await fetch(`${base}/api/send`, { method: "POST", headers, body: "{bad-json" })).status,
      400
    );

    const addContactRes = (await fetch(`${base}/api/contacts/book`, {
      method: "POST",
      headers,
      body: JSON.stringify({ phone: "0837776666", name: "Sarah", note: "Colleague" }),
    }).then((r) => r.json())) as { ok: boolean; data: { id: string } };
    assert.equal(addContactRes.ok, true);

    const delContactRes = (await fetch(
      `${base}/api/contacts/book/${encodeURIComponent(addContactRes.data.id)}`,
      { method: "DELETE", headers }
    ).then((r) => r.json())) as { deleted: boolean };
    assert.equal(delContactRes.deleted, true);

    assert.equal((await fetch(`${base}/api/contacts`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/archive/thread`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/archive/sync`, { method: "POST", headers })).status, 200);
    assert.equal((await fetch(`${base}/api/sync`, { method: "POST", headers })).status, 200);

    const firstUid = [...archiveStore.messages.keys()][0]!;
    const delArchiveRes = await fetch(`${base}/api/delete`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        indices: [40105],
        uids: [firstUid],
        deleteFromCpe: true,
        deleteFromArchive: true,
      }),
    });
    assert.equal(delArchiveRes.status, 200);

    const logoutRes = await fetch(`${base}/api/auth/logout`, { method: "POST" });
    assert.equal(logoutRes.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
