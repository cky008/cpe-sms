import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContactStore } from "../src/contacts.ts";
import { createHttpApiServer } from "../src/http-server.ts";
import { SmsArchiveStore } from "../src/sms-archive.ts";
import {
  ACCENT_PALETTE,
  BASE_THEMES,
  describeSmsMode,
  estimateLocalSmsMode,
  formatDayLabel,
  formatShortTime,
  initialsOf,
  isLikelyContactNameQuery,
  signalLevel,
  threadGroupLabel,
} from "../src/web/client/ui-format.ts";

const ROOT_DIR = path.resolve(process.cwd());
const INDEX_HTML_PATH = path.join(ROOT_DIR, "src", "web", "public", "index.html");
const APP_TS_PATH = path.join(ROOT_DIR, "src", "web", "client", "app.ts");
const UI_FORMAT_TS_PATH = path.join(ROOT_DIR, "src", "web", "client", "ui-format.ts");
const APP_JS_PATH = path.join(ROOT_DIR, "src", "web", "public", "app.js");
const APP_CSS_PATH = path.join(ROOT_DIR, "src", "web", "public", "app.css");
const FAVICON_PATH = path.join(ROOT_DIR, "src", "web", "public", "favicon.svg");

test("Sujian web UI enforces zero-emoji policy across HTML, TypeScript client, and compiled JS", () => {
  const emojiRegex = /\p{Extended_Pictographic}/u;
  for (const filePath of [INDEX_HTML_PATH, APP_TS_PATH, UI_FORMAT_TS_PATH, APP_JS_PATH, FAVICON_PATH]) {
    const content = fs.readFileSync(filePath, "utf8");
    const match = content.match(emojiRegex);
    assert.equal(
      match,
      null,
      `Expected zero emoji in ${path.basename(filePath)}, but found "${match?.[0] ?? ""}"`
    );
  }
});

test("Sujian SVG icon sprite defines every <use href=\"#i-...\"> symbol referenced in HTML and TS", () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  const ts = fs.readFileSync(APP_TS_PATH, "utf8");

  const definedSymbols = new Set<string>();
  for (const m of html.matchAll(/<symbol\s+id="(i-[a-z0-9-]+)"/g)) {
    if (m[1]) definedSymbols.add(m[1]);
  }
  assert.ok(definedSymbols.size >= 18, "Expected comprehensive stroke SVG icon sprite");

  const referencedIcons = new Set<string>();
  for (const m of html.matchAll(/href="#(i-[a-z0-9-]+)"/g)) {
    if (m[1]) referencedIcons.add(m[1]);
  }
  for (const m of ts.matchAll(/\bicon\(\s*"([a-z0-9-]+)"/g)) {
    if (m[1]) referencedIcons.add(`i-${m[1]}`);
  }
  for (const f of ["inbox", "unread", "key"]) {
    referencedIcons.add(`i-${f}`);
  }

  for (const ref of referencedIcons) {
    assert.ok(definedSymbols.has(ref), `Missing <symbol id="${ref}"> in index.html icon sprite`);
  }
});

test("Sujian daisyUI stylesheet compiles 4 base themes, 9 accents, elevated surfaces, and reduced-motion rules", async () => {
  const css = fs.readFileSync(APP_CSS_PATH, "utf8");
  assert.match(css, /daisyui/i);

  for (const theme of BASE_THEMES) {
    assert.match(css, new RegExp(`data-theme=${theme.id}|data-theme="${theme.id}"`));
  }
  assert.equal(BASE_THEMES.length, 4);

  for (const accent of ACCENT_PALETTE) {
    if (accent.id !== "default") {
      assert.match(css, new RegExp(`data-accent="${accent.id}"|data-accent=${accent.id}`));
    }
  }
  assert.equal(ACCENT_PALETTE.length, 10);

  assert.match(css, /--surface-elevated/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);

  const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  assert.match(html, /id="appearanceModal"/);
  assert.match(html, /id="loginAppearanceBtn"/);
  assert.doesNotMatch(html, /id="newSmsPhoneInput"[^>]*input-ghost/);

  // Verify HTTP server serves modular client JS assets too
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-web-ui-"));
  const contactStore = new ContactStore(path.join(tmpDir, "contacts.json"), "+353");
  const archiveStore = new SmsArchiveStore({
    filePath: path.join(tmpDir, "archive.json"),
    contactStore,
  });
  const server = createHttpApiServer({
    cpeClient: {} as never,
    archiveStore,
    contactStore,
    apiToken: "test-token",
    serveWebUi: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ui-format.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Sujian pure UI helpers format dates, initials, signal bars, SMS segments, and contact queries", () => {
  // Initials
  assert.equal(initialsOf("Sean Murphy"), "SM");
  assert.equal(initialsOf("Revolut"), "RE");
  assert.equal(initialsOf("林知夏"), "林");
  assert.equal(initialsOf("  +353 83 123 "), "35");
  assert.equal(initialsOf("   "), "?");

  // Signal bars
  assert.equal(signalLevel("-78dBm"), 4);
  assert.equal(signalLevel("-86dBm"), 3);
  assert.equal(signalLevel("-95dBm"), 2);
  assert.equal(signalLevel("-108dBm"), 1);
  assert.equal(signalLevel("-118dBm"), 0);
  assert.equal(signalLevel(""), 0);

  // SMS encoding & segment counter
  assert.deepEqual(estimateLocalSmsMode(""), { encoding: "7BIT", segments: 0, len: 0 });
  assert.deepEqual(estimateLocalSmsMode("Hello Dublin"), { encoding: "7BIT", segments: 1, len: 12 });
  assert.equal(estimateLocalSmsMode("A".repeat(161)).segments, 2);
  assert.deepEqual(estimateLocalSmsMode("你好世界"), { encoding: "UCS2", segments: 1, len: 4 });
  assert.equal(estimateLocalSmsMode("中".repeat(71)).segments, 2);
  assert.equal(describeSmsMode(""), "GSM-7 · 0 字");
  assert.equal(describeSmsMode("你好"), "UCS-2 · 2 字 · 1 条");

  // Date & section grouping (anchored to 2026-10-28 Wednesday)
  const refNow = new Date(2026, 9, 28, 15, 30, 0);
  assert.equal(formatShortTime("2026-10-28 14:05:09", refNow), "14:05");
  assert.equal(formatShortTime("2026-10-27 09:12:00", refNow), "昨天");
  assert.equal(formatShortTime("2026-10-25 09:12:00", refNow), "周日");
  assert.equal(formatShortTime("2026-09-04 09:12:00", refNow), "9月4日");
  assert.equal(formatShortTime("2025-12-31 23:59:00", refNow), "2025/12/31");

  assert.equal(formatDayLabel("2026-10-28", refNow), "今天");
  assert.equal(formatDayLabel("2026-10-27", refNow), "昨天");
  assert.equal(formatDayLabel("2026-10-25", refNow), "10月25日 周日");
  assert.equal(formatDayLabel("2025-12-31", refNow), "2025年12月31日");

  assert.equal(threadGroupLabel("2026-10-28 08:00:00", refNow), "今天");
  assert.equal(threadGroupLabel("2026-10-27 22:00:00", refNow), "昨天");
  assert.equal(threadGroupLabel("2026-10-24 10:00:00", refNow), "本周");
  assert.equal(threadGroupLabel("2026-10-05 10:00:00", refNow), "本月");
  assert.equal(threadGroupLabel("2026-08-01 10:00:00", refNow), "更早");

  // Contact name vs dialable phone query classifier
  assert.equal(isLikelyContactNameQuery("Sean"), true);
  assert.equal(isLikelyContactNameQuery("林知夏"), true);
  assert.equal(isLikelyContactNameQuery("0831234567"), false);
  assert.equal(isLikelyContactNameQuery("+353831234567"), false);
  assert.equal(isLikelyContactNameQuery(""), false);
});
