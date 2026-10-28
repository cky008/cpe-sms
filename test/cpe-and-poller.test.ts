import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CpeApiError, HuaweiCpeClient } from "../src/cpe-client.ts";
import { aesGcmDecrypt, aesGcmEncrypt, curve25519Mul } from "../src/crypto.ts";
import { createHttpApiServer } from "../src/http-server.ts";
import { SmsPoller } from "../src/poller.ts";
import { SmsArchiveStore } from "../src/sms-archive.ts";
import { ContactStore } from "../src/contacts.ts";
import { StateStore } from "../src/state-store.ts";
import { getXmlTag } from "../src/xml.ts";

function createMockCpe(password = "SecretPass123", opts: { disableSmsList?: boolean } = {}) {
  const saltHex = "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff";
  const iterations = 100;
  const serverEccPriv = BigInt(
    "0x09112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
  );
  const serverEccPub = curve25519Mul(serverEccPriv, 9n).toString(16).padStart(64, "0");

  let stateLogin = "-1";
  let unread = 2;
  let loginCount = 0;
  let logoutCount = 0;
  let lastSentSmsXml = "";
  let firstNonceSaved = "";
  let serverNonceSaved = "";

  const inbox = [
    {
      index: 40002,
      phone: "10086",
      content: "【中国移动】验证码 654321",
      date: "2026-10-27 22:00:00",
      smstat: "0",
    },
    {
      index: 40001,
      phone: "Three",
      content: "Welcome to Three 5G",
      date: "2026-10-27 21:00:00",
      smstat: "0",
    },
  ];

  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const urlStr = String(input);
    const u = new URL(urlStr);
    const p = u.pathname;
    const body = String(init.body ?? "");

    const makeRes = (xml: string, headersObj: Record<string, string> = {}) =>
      new Response(xml, {
        status: 200,
        headers: {
          "content-type": "text/xml",
          __requestverificationtokenone:
            "tok_" + Math.random().toString(36).slice(2, 10).padEnd(32, "x"),
          ...headersObj,
        },
      });

    if (p === "/api/user/state-login") {
      return makeRes(
        `<response><State>${stateLogin}</State><lockstatus>0</lockstatus><password_type>4</password_type></response>`
      );
    }
    if (p === "/api/monitoring/check-notifications") {
      return makeRes(
        `<response><UnreadMessage>${unread}</UnreadMessage><SmsStorageFull>0</SmsStorageFull></response>`
      );
    }
    if (p === "/api/device/basic_information") {
      return makeRes(
        `<response><devicename>H168-383</devicename><spreadname_zh>5G CPE Ultra 6</spreadname_zh></response>`
      );
    }
    if (p === "/api/device/signal") {
      return makeRes(`<response><nr_rsrp>-92dBm</nr_rsrp><nr_sinr>18dB</nr_sinr></response>`);
    }
    if (p === "/api/net/current-plmn") {
      return makeRes(`<response><FullName>3Ireland</FullName><Numeric>27205</Numeric></response>`);
    }
    if (p === "/api/monitoring/status") {
      return makeRes(`<response><ConnectionStatus>901</ConnectionStatus></response>`, {
        "set-cookie": "SessionID=mock_sess_1; Path=/; HttpOnly",
      });
    }
    if (p === "/api/webserver/token") {
      return makeRes(`<response><token>${"a".repeat(32)}${"b".repeat(32)}</token></response>`);
    }
    if (p === "/api/user/challenge_login") {
      firstNonceSaved = getXmlTag(body, "firstnonce") ?? "";
      serverNonceSaved = `${firstNonceSaved}${"cc".repeat(16)}`;
      return makeRes(
        `<response><salt>${saltHex}</salt><iterations>${iterations}</iterations><servernonce>${serverNonceSaved}</servernonce></response>`
      );
    }
    if (p === "/api/user/authentication_login") {
      const proofHex = getXmlTag(body, "clientproof") ?? "";
      const salted = crypto.pbkdf2Sync(
        Buffer.from(password, "latin1"),
        Buffer.from(saltHex, "hex"),
        iterations,
        32,
        "sha256"
      );
      const ck = crypto.createHmac("sha256", "Client Key").update(salted).digest();
      const sk = crypto.createHmac("sha256", "Server Key").update(salted).digest();
      const stored = crypto.createHash("sha256").update(ck).digest();
      const authMsg = Buffer.from(
        `${firstNonceSaved},${serverNonceSaved},${serverNonceSaved}`,
        "utf8"
      );
      const csig = crypto.createHmac("sha256", authMsg).update(stored).digest();
      const expectedProof = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) expectedProof[i] = ck[i]! ^ csig[i]!;

      if (proofHex !== expectedProof.toString("hex")) {
        return makeRes(`<error><code>108006</code><remaincount>2</remaincount></error>`);
      }

      loginCount += 1;
      stateLogin = "0";
      const serverSig = crypto.createHmac("sha256", authMsg).update(sk).digest("hex");
      const eccSig = crypto
        .createHmac("sha256", sk)
        .update(Buffer.from(serverEccPub, "hex"))
        .digest("hex");
      return makeRes(
        `<response><serversignature>${serverSig}</serversignature><ecc_server_pubkey>${serverEccPub}</ecc_server_pubkey><ecc_pubkey_signature>${eccSig}</ecc_pubkey_signature></response>`
      );
    }
    if (p === "/api/user/logout") {
      logoutCount += 1;
      stateLogin = "-1";
      return makeRes(`<response>OK</response>`);
    }
    if (p === "/api/sms/sms-count") {
      return makeRes(
        `<response><LocalUnread>${unread}</LocalUnread><LocalInbox>${inbox.length}</LocalInbox><LocalOutbox>1</LocalOutbox><LocalMax>500</LocalMax></response>`
      );
    }
    if (p === "/api/sms/sms-count-contact" && init.method === "GET") {
      return makeRes(`<response><count>${inbox.length}</count></response>`);
    }
    if (p === "/api/sms/sms-list") {
      if (opts.disableSmsList) {
        return makeRes(`<error><code>100002</code></error>`);
      }
      const boxType = getXmlTag(body, "BoxType");
      if (boxType === "2") {
        return makeRes(
          `<response><Count>1</Count><Messages><Message><Smstat>3</Smstat><Index>40010</Index><Phone>+353831234567</Phone><Content>Outbox test</Content><Date>2026-10-27 22:01:00</Date><Smstype>1</Smstype></Message></Messages></response>`
        );
      }
      const items = inbox
        .map(
          (m) =>
            `<Message><Smstat>${m.smstat}</Smstat><Index>${m.index}</Index><Phone>${m.phone}</Phone><Content>${m.content}</Content><Date>${m.date}</Date><Smstype>1</Smstype></Message>`
        )
        .join("");
      return makeRes(`<response><Count>${inbox.length}</Count><Messages>${items}</Messages></response>`);
    }

    const clientPub = u.searchParams.get("ecc-client-pubkey");
    const encType = u.searchParams.get("enc-type");
    if (clientPub && encType) {
      const shareKeyHex = curve25519Mul(serverEccPriv, BigInt(`0x${clientPub}`)).toString(16);
      if (p === "/api/sms/sms-count-contact") {
        return makeRes(`<response><count>1</count></response>`);
      }
      if (p === "/api/sms/sms-list-phone") {
        const xml = `<response><Count>1</Count><messages><message><index>40002</index><phone>10086</phone><content>【中国移动】验证码 654321</content><date>2026-10-27 22:00:00</date><smstat>0</smstat><smstype>1</smstype></message></messages></response>`;
        return makeRes(aesGcmEncrypt(xml, shareKeyHex));
      }
      if (p === "/api/sms/sms-list-contact") {
        const xml =
          `<response><Count>${inbox.length}</Count><messages>` +
          inbox
            .map(
              (m) =>
                `<message><index>${m.index}</index><phone>${m.phone}</phone><content>${m.content}</content><date>${m.date}</date><smstat>${m.smstat}</smstat><smstype>1</smstype></message>`
            )
            .join("") +
          `</messages></response>`;
        return makeRes(aesGcmEncrypt(xml, shareKeyHex));
      }
      if (p === "/api/sms/send-sms") {
        lastSentSmsXml = aesGcmDecrypt(body, shareKeyHex);
        return makeRes(`<response>OK</response>`);
      }
      if (p === "/api/sms/send-status") {
        const phone = getXmlTag(lastSentSmsXml, "Phone") ?? "";
        return makeRes(
          aesGcmEncrypt(
            `<response><Phone></Phone><SucPhone>${phone}</SucPhone><FailPhone></FailPhone><SendFailCode>0</SendFailCode></response>`,
            shareKeyHex
          )
        );
      }
    }

    return makeRes(`<response>OK</response>`);
  };

  return {
    fetchImpl,
    pushIncomingSms(msg: (typeof inbox)[number]) {
      inbox.unshift(msg);
      unread += 1;
    },
    getStats() {
      return { loginCount, logoutCount, lastSentSmsXml, stateLogin };
    },
  };
}

test("HuaweiCpeClient logs in via SCRAM, executes status/thread/all/send/markRead/delete, and always logs out", async () => {
  const mock = createMockCpe("RightPass!1");
  const client = new HuaweiCpeClient({
    cpeUrl: "http://192.168.8.1",
    cpePassword: "RightPass!1",
    fetchImpl: mock.fetchImpl,
  });

  const status = await client.getStatusSummary();
  assert.equal(status.device.deviceName, "H168-383");
  assert.equal(status.network?.operatorName, "3Ireland");

  const contacts = await client.listContacts();
  assert.equal(contacts?.contacts.length, 2);
  assert.equal(mock.getStats().stateLogin, "-1");

  const thread = await client.listPhoneMessages("10086");
  assert.equal(thread?.messages.length, 1);

  const fullDump = await client.fetchAllMessages();
  assert.equal(fullDump?.messages.length, 3); // 2 inbox + 1 outbox

  const sendRes = await client.sendSms("+8613800138000", "测试发送 / hello", {
    pollIntervalMs: 10,
  });
  assert.equal(sendRes.ok, true);
  assert.deepEqual(sendRes.sentPhones, ["+8613800138000"]);
  assert.equal(mock.getStats().lastSentSmsXml.includes("&#x2F;"), true);

  const readRes = await client.markRead([40002]);
  assert.equal(readRes.count, 1);

  const delRes = await client.deleteSms([40001]);
  assert.equal(delRes.count, 1);

  const delContactRes = await client.deleteContacts(["10086"]);
  assert.equal(delContactRes.count, 1);

  // Also verify encrypted fallback when `/api/sms/sms-list` is unsupported
  const fallbackMock = createMockCpe("RightPass!1", { disableSmsList: true });
  const fallbackClient = new HuaweiCpeClient({
    cpeUrl: "http://192.168.8.1",
    cpePassword: "RightPass!1",
    fetchImpl: fallbackMock.fetchImpl,
  });
  const fbDump = await fallbackClient.fetchAllMessages();
  assert.equal(fbDump !== null && fbDump.messages.length >= 1, true);
});

test("HuaweiCpeClient never retries wrong-password 108006 errors and validates sendSms inputs", async () => {
  const mock = createMockCpe("RightPass!1");
  const badClient = new HuaweiCpeClient({
    cpeUrl: "http://192.168.8.1",
    cpePassword: "WrongPassword",
    fetchImpl: mock.fetchImpl,
  });

  await assert.rejects(
    () => badClient.listContacts(),
    (err: unknown) => err instanceof CpeApiError && err.code === "108006"
  );
  assert.equal(mock.getStats().loginCount, 0);

  await assert.rejects(() => badClient.sendSms("", "hi"), /号码不能为空/);
  await assert.rejects(() => badClient.sendSms("Three", "hi"), /无效或不可回复/);
  await assert.rejects(() => badClient.sendSms("10086", "   "), /不能为空/);
});

test("SmsPoller seeds full archive on start and emits new_sms on arrival without duplicates", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-sms-test-"));
  const stateStore = new StateStore(path.join(tmpDir, "state.json"));
  const contactStore = new ContactStore(path.join(tmpDir, "contacts.json"));
  const archiveStore = new SmsArchiveStore({
    filePath: path.join(tmpDir, "archive.json"),
    contactStore,
  });
  const mock = createMockCpe("RightPass!1");
  const client = new HuaweiCpeClient({
    cpeUrl: "http://192.168.8.1",
    cpePassword: "RightPass!1",
    fetchImpl: mock.fetchImpl,
  });

  const poller = new SmsPoller({
    cpeClient: client,
    stateStore,
    archiveStore,
    seedExistingOnStart: true,
    autoMarkRead: true,
    pollIntervalMs: 60000,
  });

  const received: Array<{ index: number; verificationCode?: string | null }> = [];
  poller.on("new_sms", (sms) => received.push(sms));

  await poller.start();
  assert.equal(received.length, 0);
  assert.equal(stateStore.data.seeded, true);
  assert.equal(archiveStore.messages.size, 3);

  mock.pushIncomingSms({
    index: 40003,
    phone: "10690000",
    content: "【GitHub】您的登录验证码为 918273，请勿泄露。",
    date: "2026-10-27 22:30:00",
    smstat: "0",
  });

  await poller.tick();
  assert.equal(received.length, 1);
  assert.equal(received[0]?.index, 40003);
  assert.equal(received[0]?.verificationCode, "918273");

  await poller.tick();
  assert.equal(received.length, 1);

  poller.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("HTTP REST API enforces Bearer token and exposes /healthz, /api/status, /api/messages, /api/send, /api/read, /api/delete", async () => {
  const mock = createMockCpe("RightPass!1");
  const client = new HuaweiCpeClient({
    cpeUrl: "http://192.168.8.1",
    cpePassword: "RightPass!1",
    fetchImpl: mock.fetchImpl,
  });

  const server = createHttpApiServer({ cpeClient: client, apiToken: "my-api-secret" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const authHeaders = {
    Authorization: "Bearer my-api-secret",
    "Content-Type": "application/json",
  };

  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/api/contacts`)).status, 401);

    const statusRes = (await fetch(`${base}/api/status`, { headers: authHeaders }).then((r) =>
      r.json()
    )) as { ok: boolean };
    assert.equal(statusRes.ok, true);

    const msgsRes = (await fetch(`${base}/api/messages?unread=1`, { headers: authHeaders }).then(
      (r) => r.json()
    )) as { ok: boolean };
    assert.equal(msgsRes.ok, true);

    const phoneMsgsRes = (await fetch(`${base}/api/messages?phone=10086`, {
      headers: authHeaders,
    }).then((r) => r.json())) as { ok: boolean };
    assert.equal(phoneMsgsRes.ok, true);

    const sendRes = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ phone: "0831234567", content: "Hello!" }),
    });
    assert.equal(sendRes.status, 200);

    const readRes = await fetch(`${base}/api/read`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ indices: [40002] }),
    });
    assert.equal(readRes.status, 200);

    const delRes = await fetch(`${base}/api/messages/40002`, {
      method: "DELETE",
      headers: authHeaders,
    });
    assert.equal(delRes.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
