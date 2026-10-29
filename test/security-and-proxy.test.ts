import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { ContactStore } from "../src/contacts.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import {
  createHttpApiServer,
  getClientIp,
  isPrivateOrLoopbackIp,
  isValidSameOrigin,
} from "../src/http-server.ts";
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

test("HTTP security hardening: revocable sessions, SameSite=Strict, CSRF origin check, IP spoofing defense, and minimal /healthz", async () => {
  const fakeCpe = {
    async getStatusSummary() {
      return { device: { deviceName: "H168-383", marketingName: "5G CPE Ultra 6", classify: "cpe" } };
    },
  };

  const server = createHttpApiServer({
    cpeClient: fakeCpe as never,
    apiToken: "portal-pass-2026",
    serveWebUi: true,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. /healthz minimal info disclosure
    const healthRes = await fetch(`${baseUrl}/healthz`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.service, "cpe-sms");
    assert.equal(healthJson.archiveCount, undefined, "archiveCount must not be leaked on /healthz");
    assert.equal(healthJson.timestamp, undefined, "timestamp must not be leaked on /healthz");

    // 2. Login returns SameSite=Strict and a random revocable session token
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "portal-pass-2026" }),
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /SameSite=Strict/i, "Session cookie must enforce SameSite=Strict");
    const cookieHeader = setCookie.split(";")[0]!;
    assert.match(cookieHeader, /^cpe_sms_session=[a-f0-9]{64}$/, "Session token must be a 32-byte random hex string");

    // 3. Authorized request with valid cookie and same-origin Origin header
    const checkAuth1 = await fetch(`${baseUrl}/api/auth/check`, {
      headers: { Cookie: cookieHeader },
    });
    const checkAuth1Json = (await checkAuth1.json()) as { authenticated: boolean };
    assert.equal(checkAuth1Json.authenticated, true);

    // 4. CSRF protection: Mutating POST with cookie auth but cross-origin Origin header rejected with 403
    const csrfPost = await fetch(`${baseUrl}/api/sms/preview`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        Origin: "https://evil-attacker.example.com",
      },
      body: JSON.stringify({ phone: "0831234567", content: "Phishing test" }),
    });
    assert.equal(csrfPost.status, 403, "Cross-origin mutating POST with cookie must be rejected with 403");
    const csrfJson = (await csrfPost.json()) as { ok: boolean; error: string };
    assert.equal(csrfJson.ok, false);
    assert.match(csrfJson.error, /cross-origin/i);

    // 5. Same-origin mutating POST with cookie succeeds
    const validPost = await fetch(`${baseUrl}/api/sms/preview`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ phone: "0831234567", content: "Legit test" }),
    });
    assert.equal(validPost.status, 200);

    // 6. Logout revokes the session on the server
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookieHeader, Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(logoutRes.status, 200);

    // 7. Replay of old session cookie is now rejected
    const checkAuth2 = await fetch(`${baseUrl}/api/auth/check`, {
      headers: { Cookie: cookieHeader },
    });
    const checkAuth2Json = (await checkAuth2.json()) as { authenticated: boolean };
    assert.equal(checkAuth2Json.authenticated, false, "Revoked session cookie must no longer be authenticated");

    const statusAfterLogout = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(statusAfterLogout.status, 401, "Protected API must return 401 with revoked session cookie");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("isPrivateOrLoopbackIp accurately identifies loopback, RFC 1918, CGNAT, and rejects public IPs", () => {
  assert.equal(isPrivateOrLoopbackIp("127.0.0.1"), true);
  assert.equal(isPrivateOrLoopbackIp("::1"), true);
  assert.equal(isPrivateOrLoopbackIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateOrLoopbackIp("192.168.1.1"), true);
  assert.equal(isPrivateOrLoopbackIp("10.0.0.1"), true);
  assert.equal(isPrivateOrLoopbackIp("172.16.0.1"), true);
  assert.equal(isPrivateOrLoopbackIp("172.31.255.254"), true);
  assert.equal(isPrivateOrLoopbackIp("100.64.0.1"), true); // Tailscale / CGNAT
  assert.equal(isPrivateOrLoopbackIp("100.127.255.254"), true);

  // Public internet IPs must return false
  assert.equal(isPrivateOrLoopbackIp("8.8.8.8"), false);
  assert.equal(isPrivateOrLoopbackIp("203.0.113.195"), false);
  assert.equal(isPrivateOrLoopbackIp("172.32.0.1"), false);
  assert.equal(isPrivateOrLoopbackIp("100.128.0.1"), false);
});

test("getClientIp ignores spoofed X-Forwarded-For on public direct connections and selects rightmost proxy IP", () => {
  // Direct public internet connection: attacker cannot spoof X-Forwarded-For
  const publicReq = {
    socket: { remoteAddress: "203.0.113.50" },
    headers: { "x-forwarded-for": "1.2.3.4" },
  } as unknown as import("node:http").IncomingMessage;
  assert.equal(getClientIp(publicReq), "203.0.113.50");

  // Local reverse proxy: trust the rightmost client IP recorded in the forwarded chain
  const proxiedReq = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-forwarded-for": "1.2.3.4, 198.51.100.22" },
  } as unknown as import("node:http").IncomingMessage;
  assert.equal(getClientIp(proxiedReq), "198.51.100.22");

  // Single forwarded IP through local proxy
  const singleProxiedReq = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-forwarded-for": "100.64.0.15" },
  } as unknown as import("node:http").IncomingMessage;
  assert.equal(getClientIp(singleProxiedReq), "100.64.0.15");
});

test("isValidSameOrigin validates Origin and Referer against Host / X-Forwarded-Host", () => {
  const matchingOrigin = {
    headers: { host: "sms.example.com", origin: "https://sms.example.com" },
  } as unknown as import("node:http").IncomingMessage;
  assert.equal(isValidSameOrigin(matchingOrigin), true);

  const evilOrigin = {
    headers: { host: "sms.example.com", origin: "https://evil-attacker.example.com" },
  } as unknown as import("node:http").IncomingMessage;
  assert.equal(isValidSameOrigin(evilOrigin), false);

  const xForwardedHostMatch = {
    headers: {
      host: "127.0.0.1:18383",
      "x-forwarded-host": "sms.example.com",
      origin: "https://sms.example.com",
    },
  } as unknown as import("node:http").IncomingMessage;
  assert.equal(isValidSameOrigin(xForwardedHostMatch), true);

  const evilReferer = {
    headers: { host: "sms.example.com", referer: "https://evil.com/phish" },
  } as unknown as import("node:http").IncomingMessage;
  assert.equal(isValidSameOrigin(evilReferer), false);
});
