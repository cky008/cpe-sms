import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { ContactStore } from "../src/contacts.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { createHttpApiServer } from "../src/http-server.ts";
import { SmsArchiveStore } from "../src/sms-archive.ts";
import { StateStore } from "../src/state-store.ts";

test("loadConfig defaults httpPort to 0 (avoiding NAS 8080 collision), webPort to 18383, and derives dataEncryptionKey", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-cfg-"));
  const envFile = path.join(tmpDir, ".env");
  fs.writeFileSync(
    envFile,
    "CPE_URL=http://192.168.8.1/#/sms\nCPE_PASSWORD=MyCpeSecret99\nTELEGRAM_API=123:tok\n",
    "utf8"
  );

  try {
    const cfg = loadConfig({
      envPath: envFile,
      ignoreProcessEnv: true,
    });
    assert.equal(cfg.cpeUrl, "http://192.168.8.1");
    assert.equal(cfg.webEnabled, true);
    assert.equal(cfg.webPort, 18383);
    assert.equal(cfg.httpPort, 0);
    assert.equal(cfg.dataEncryptionKey, "MyCpeSecret99");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("StateStore, ContactStore, and SmsArchiveStore encrypt all sensitive data at rest on disk", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-stores-enc-"));
  const cipher = new StorageCipher("nas-at-rest-secret-2026");

  const stateFile = path.join(tmpDir, "state.json");
  const contactsFile = path.join(tmpDir, "contacts.json");
  const archiveFile = path.join(tmpDir, "sms-archive.json");

  try {
    const stateStore = new StateStore(stateFile, cipher);
    stateStore.authorizeChat("888777666");
    stateStore.bindReplyTarget("888777666", 42, "+353831234567");

    const contactStore = new ContactStore(contactsFile, "+353", cipher);
    contactStore.upsertManualContact({ phone: "0831234567", name: "Secret Landlord" });

    const archiveStore = new SmsArchiveStore({
      filePath: archiveFile,
      contactStore,
      defaultCountryCode: "+353",
      cipher,
    });
    archiveStore.recordRealtimeMessage({
      index: 40100,
      phone: "+353831234567",
      content: "Your secret OTP code is 998877",
      date: "2026-10-27 23:00:00",
      smstat: "0",
      curbox: "0",
      isUnread: true,
      direction: "in",
    });

    // Verify zero plaintext leakage across all 3 files on disk
    for (const f of [stateFile, contactsFile, archiveFile]) {
      const diskRaw = fs.readFileSync(f, "utf8");
      assert.match(diskRaw, /cpe-sms-aes-256-gcm-v1/);
      assert.equal(diskRaw.includes("888777666"), false);
      assert.equal(diskRaw.includes("+353831234567"), false);
      assert.equal(diskRaw.includes("Secret Landlord"), false);
      assert.equal(diskRaw.includes("998877"), false);
    }

    // Verify clean reload from encrypted disk files
    const reloadedState = new StateStore(stateFile, cipher);
    assert.equal(reloadedState.isChatAuthorized("888777666"), true);

    const reloadedContacts = new ContactStore(contactsFile, "+353", cipher);
    assert.equal(reloadedContacts.resolvePhone("+353831234567")?.name, "Secret Landlord");

    const reloadedArchive = new SmsArchiveStore({
      filePath: archiveFile,
      contactStore: reloadedContacts,
      defaultCountryCode: "+353",
      cipher,
    });
    assert.equal(reloadedArchive.messages.size, 1);
    assert.equal(reloadedArchive.listThreads()[0]?.latestOtp, "998877");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HTTP server sets Secure cookie behind HTTPS reverse proxy (sms.example.com), security headers, and login rate limit", async () => {
  const fakeCpe = {
    async getStatusSummary() {
      return { device: { deviceName: "H168-383", marketingName: "5G CPE Ultra 6", classify: "cpe" } };
    },
  };

  const server = createHttpApiServer({
    cpeClient: fakeCpe as never,
    apiToken: "strong-portal-pass",
    serveWebUi: true,
    maxLoginFailures: 3,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. HTTPS reverse proxy (`X-Forwarded-Proto: https` from Synology Nginx for sms.example.com) -> Secure cookie!
    const httpsLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "100.64.0.10",
      },
      body: JSON.stringify({ password: "strong-portal-pass" }),
    });
    assert.equal(httpsLogin.status, 200);
    assert.equal(httpsLogin.headers.get("x-content-type-options"), "nosniff");
    assert.equal(httpsLogin.headers.get("x-frame-options"), "DENY");
    assert.equal(httpsLogin.headers.get("referrer-policy"), "no-referrer");
    const httpsCookie = httpsLogin.headers.get("set-cookie") ?? "";
    assert.match(httpsCookie, /HttpOnly/);
    assert.match(httpsCookie, /Secure/);

    // 2. Plain HTTP on LAN (`http://192.168.8.108:18383`) omits `Secure` so LAN browsers work
    const lanLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "192.168.8.50",
      },
      body: JSON.stringify({ password: "strong-portal-pass" }),
    });
    assert.equal(lanLogin.status, 200);
    const lanCookie = lanLogin.headers.get("set-cookie") ?? "";
    assert.equal(/;\s*Secure/i.test(lanCookie), false);

    // 3. Brute-force rate limit triggers 429 after maxLoginFailures (3) from attacker IP
    for (let i = 0; i < 3; i++) {
      const bad = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "100.64.0.99",
        },
        body: JSON.stringify({ password: "wrong" }),
      });
      assert.equal(bad.status, 401);
    }

    const blocked = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "100.64.0.99",
      },
      body: JSON.stringify({ password: "strong-portal-pass" }),
    });
    assert.equal(blocked.status, 429);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Repository tracks empty data/.gitkeep so Synology DSM bind mount ./data always exists after clone", () => {
  const gitkeepPath = path.resolve(process.cwd(), "data", ".gitkeep");
  assert.equal(fs.existsSync(gitkeepPath), true);
  assert.equal(fs.readFileSync(gitkeepPath, "utf8"), "");
});
