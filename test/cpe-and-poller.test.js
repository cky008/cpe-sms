import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HuaweiCpeClient, CpeApiError } from "../src/cpe-client.js";
import { aesGcmDecrypt, aesGcmEncrypt, curve25519Mul } from "../src/crypto.js";
import { createHttpApiServer } from "../src/http-server.js";
import { SmsPoller } from "../src/poller.js";
import { StateStore } from "../src/state-store.js";
import { getXmlTag } from "../src/xml.js";

/**
 * Create a realistic in-memory mock H168-383 router supporting SCRAM-SHA256 + Curve25519 + AES-256-GCM.
 */
function createMockCpe(password = "SecretPass123") {
  const saltHex = "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff";
  const iterations = 100;
  const serverEccPriv = BigInt("0x09112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
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

  const fetchImpl = async (urlStr, init = {}) => {
    const u = new URL(urlStr);
    const p = u.pathname;
    const body = String(init.body ?? "");

    const makeRes = (xml, headersObj = {}) =>
      new Response(xml, {
        status: 200,
        headers: {
          "content-type": "text/xml",
          __requestverificationtokenone: "tok_" + Math.random().toString(36).slice(2, 10).padEnd(32, "x"),
          ...headersObj,
        },
      });

    if (p === "/api/user/state-login") {
      return makeRes(
        `<response><State>${stateLogin}</State><lockstatus>0</lockstatus><password_type>4</password_type></response>`
      );
    }
    if (p === "/api/monitoring/check-notifications") {
      return makeRes(`<response><UnreadMessage>${unread}</UnreadMessage><SmsStorageFull>0</SmsStorageFull></response>`);
    }
    if (p === "/api/device/basic_information") {
      return makeRes(`<response><devicename>H168-383</devicename><spreadname_zh>5G CPE Ultra 6</spreadname_zh></response>`);
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
      const authMsg = Buffer.from(`${firstNonceSaved},${serverNonceSaved},${serverNonceSaved}`, "utf8");
      const csig = crypto.createHmac("sha256", authMsg).update(stored).digest();
      const expectedProof = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) expectedProof[i] = ck[i] ^ csig[i];

      if (proofHex !== expectedProof.toString("hex")) {
        return makeRes(`<error><code>108006</code><remaincount>2</remaincount></error>`);
      }

      loginCount += 1;
      stateLogin = "0";
      const serverSig = crypto.createHmac("sha256", authMsg).update(sk).digest("hex");
      const eccSig = crypto.createHmac("sha256", sk).update(Buffer.from(serverEccPub, "hex")).digest("hex");
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
        `<response><LocalUnread>${unread}</LocalUnread><LocalInbox>${inbox.length}</LocalInbox><LocalOutbox>0</LocalOutbox><LocalMax>500</LocalMax></response>`
      );
    }
    if (p === "/api/sms/sms-count-contact" && init.method === "GET") {
      return makeRes(`<response><count>${inbox.length}</count></response>`);
    }
    if (p === "/api/sms/sms-list") {
      const items = inbox
        .map(
          (m) =>
            `<Message><Smstat>${m.smstat}</Smstat><Index>${m.index}</Index><Phone>${m.phone}</Phone><Content>${m.content}</Content><Date>${m.date}</Date><Smstype>1</Smstype></Message>`
        )
        .join("");
      return makeRes(`<response><Count>${inbox.length}</Count><Messages>${items}</Messages></response>`);
    }

    // Encrypted endpoints
    const clientPub = u.searchParams.get("ecc-client-pubkey");
    const encType = u.searchParams.get("enc-type");
    if (clientPub && encType) {
      const shareKeyHex = curve25519Mul(serverEccPriv, BigInt(`0x${clientPub}`)).toString(16);
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
    pushIncomingSms(msg) {
      inbox.unshift(msg);
      unread += 1;
    },
    getStats() {
      return { loginCount, logoutCount, lastSentSmsXml, stateLogin };
    },
  };
}

test("HuaweiCpeClient logs in via SCRAM, executes encrypted SMS calls, and always logs out", async () => {
  const mock = createMockCpe("RightPass!1");
  const client = new HuaweiCpeClient({
    cpeUrl: "http://192.168.8.1",
    cpePassword: "RightPass!1",
    fetchImpl: mock.fetchImpl,
  });

  const contacts = await client.listContacts();
  assert.equal(contacts.contacts.length, 2);
  assert.equal(contacts.contacts[0].phone, "10086");
  assert.equal(mock.getStats().stateLogin, "-1");
  assert.equal(mock.getStats().loginCount, 1);
  assert.equal(mock.getStats().logoutCount, 1);

  const sendRes = await client.sendSms("+8613800138000", "测试发送 / hello", {
    pollIntervalMs: 10,
  });
  assert.equal(sendRes.ok, true);
  assert.deepEqual(sendRes.sentPhones, ["+8613800138000"]);
  assert.equal(mock.getStats().lastSentSmsXml.includes("&#x2F;"), true);
  assert.equal(mock.getStats().logoutCount, 2);
});

test("HuaweiCpeClient never retries wrong-password 108006 errors (protects lockout)", async () => {
  const mock = createMockCpe("RightPass!1");
  const badClient = new HuaweiCpeClient({
    cpeUrl: "http://192.168.8.1",
    cpePassword: "WrongPassword",
    fetchImpl: mock.fetchImpl,
  });

  await assert.rejects(
    () => badClient.listContacts(),
    (err) => err instanceof CpeApiError && err.code === "108006"
  );
  assert.equal(mock.getStats().loginCount, 0);
});

test("SmsPoller seeds existing SMS without flooding and emits new_sms on arrival", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-sms-test-"));
  const stateStore = new StateStore(path.join(tmpDir, "state.json"));
  const mock = createMockCpe("RightPass!1");
  const client = new HuaweiCpeClient({
    cpeUrl: "http://192.168.8.1",
    cpePassword: "RightPass!1",
    fetchImpl: mock.fetchImpl,
  });

  const poller = new SmsPoller({
    cpeClient: client,
    stateStore,
    seedExistingOnStart: true,
    pollIntervalMs: 60000,
  });

  /** @type {any[]} */
  const received = [];
  poller.on("new_sms", (sms) => received.push(sms));

  // Initial sync seeds 2 existing messages -> 0 notifications emitted
  await poller.syncOnce({ isInitial: true });
  assert.equal(received.length, 0);
  assert.equal(stateStore.data.seeded, true);

  // Simulate new incoming OTP SMS
  mock.pushIncomingSms({
    index: 40003,
    phone: "10690000",
    content: "【GitHub】您的登录验证码为 918273，请勿泄露。",
    date: "2026-10-27 22:30:00",
    smstat: "0",
  });

  await poller.tick();
  assert.equal(received.length, 1);
  assert.equal(received[0].index, 40003);
  assert.equal(received[0].verificationCode, "918273");

  // Second tick should NOT re-notify 40003
  await poller.tick();
  assert.equal(received.length, 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("HTTP REST API enforces Bearer token and exposes /healthz and /api/send", async () => {
  const mock = createMockCpe("RightPass!1");
  const client = new HuaweiCpeClient({
    cpeUrl: "http://192.168.8.1",
    cpePassword: "RightPass!1",
    fetchImpl: mock.fetchImpl,
  });

  const server = createHttpApiServer({ cpeClient: client, apiToken: "my-api-secret" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    const unauth = await fetch(`${base}/api/contacts`);
    assert.equal(unauth.status, 401);

    const contactsRes = await fetch(`${base}/api/contacts`, {
      headers: { Authorization: "Bearer my-api-secret" },
    });
    assert.equal(contactsRes.status, 200);
    const body = await contactsRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.contacts.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
