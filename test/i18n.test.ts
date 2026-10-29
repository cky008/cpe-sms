import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildLocales } from "../scripts/build-locales.ts";
import {
  describeSmsMode,
  formatDayLabel,
  formatShortTime,
  threadGroupLabel,
} from "../src/web/client/ui-format.ts";

const ROOT_DIR = path.resolve(process.cwd());
const LOCALES_DIR = path.join(ROOT_DIR, "locales");
const INDEX_HTML_PATH = path.join(ROOT_DIR, "src", "web", "public", "index.html");

function flattenKeys(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue;
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      result[fullKey] = v;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(result, flattenKeys(v as Record<string, unknown>, fullKey));
    }
  }
  return result;
}

test("buildLocales discovers locales, writes generated TS, and copies to public directories", () => {
  buildLocales();
  const generatedPath = path.join(ROOT_DIR, "src", "web", "client", "locales.generated.ts");
  assert.ok(fs.existsSync(generatedPath), "locales.generated.ts must exist");
  const code = fs.readFileSync(generatedPath, "utf8");
  assert.match(code, /SUPPORTED_LOCALES/);
  assert.match(code, /DEFAULT_LOCALE = "zh-CN"/);
  assert.match(code, /FLATTENED_LOCALES/);

  // Check public directories
  for (const dir of ["src/web/public/locales", "dist/web/public/locales"]) {
    const fullDir = path.join(ROOT_DIR, dir);
    assert.ok(fs.existsSync(path.join(fullDir, "zh-CN.json")), `Missing zh-CN.json in ${dir}`);
    assert.ok(fs.existsSync(path.join(fullDir, "en.json")), `Missing en.json in ${dir}`);
  }
});

test("Dockerfile includes locales directory in builder stage", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT_DIR, "Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /COPY\s+locales\s+\.\/locales/,
    "Dockerfile must copy locales directory into builder stage"
  );
});

test("all community locale files have 100% key parity with default zh-CN.json", () => {
  const zhFile = path.join(LOCALES_DIR, "zh-CN.json");
  assert.ok(fs.existsSync(zhFile), "locales/zh-CN.json must exist as baseline");
  const zhContent = JSON.parse(fs.readFileSync(zhFile, "utf8")) as Record<string, unknown>;
  const zhFlat = flattenKeys(zhContent);
  const zhKeys = Object.keys(zhFlat).sort();

  assert.ok(zhKeys.length > 50, "Expected a substantial dictionary of translation keys");

  const files = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 2, "Expected at least zh-CN and en locales");

  for (const file of files) {
    if (file === "zh-CN.json") continue;
    const locContent = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, file), "utf8")
    ) as Record<string, unknown>;
    const locFlat = flattenKeys(locContent);
    const locKeys = Object.keys(locFlat).sort();

    const missingInLoc = zhKeys.filter((k) => !locKeys.includes(k));
    const extraInLoc = locKeys.filter((k) => !zhKeys.includes(k));

    assert.deepEqual(
      missingInLoc,
      [],
      `Locale ${file} is missing translation keys: ${missingInLoc.join(", ")}`
    );
    assert.deepEqual(
      extraInLoc,
      [],
      `Locale ${file} has extraneous translation keys: ${extraInLoc.join(", ")}`
    );

    for (const [key, val] of Object.entries(locFlat)) {
      assert.ok(
        val.trim().length > 0,
        `Locale ${file} has an empty translation for key "${key}"`
      );
    }
  }
});

test("every data-i18n attribute in index.html matches a declared key in zh-CN.json", () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  const zhContent = JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, "zh-CN.json"), "utf8")
  ) as Record<string, unknown>;
  const zhFlat = flattenKeys(zhContent);

  const attrPatterns = [
    /data-i18n="([^"]+)"/g,
    /data-i18n-placeholder="([^"]+)"/g,
    /data-i18n-title="([^"]+)"/g,
    /data-i18n-aria="([^"]+)"/g,
    /data-i18n-tip="([^"]+)"/g,
  ];

  const referencedKeys = new Set<string>();
  for (const pat of attrPatterns) {
    for (const match of html.matchAll(pat)) {
      if (match[1]) referencedKeys.add(match[1]);
    }
  }

  assert.ok(referencedKeys.size >= 30, "Expected index.html to bind multiple UI text elements");

  for (const key of referencedKeys) {
    assert.ok(
      key in zhFlat,
      `index.html references i18n key "${key}", but it is missing from locales/zh-CN.json`
    );
  }
});

test("ui-format helpers localize short dates, day labels, thread groups, and SMS encodings", () => {
  const refNow = new Date(2026, 9, 29, 12, 0, 0); // 2026-10-29 (Thursday)

  // formatShortTime
  assert.equal(formatShortTime("2026-10-29 10:30:00", refNow, "zh-CN"), "10:30");
  assert.equal(formatShortTime("2026-10-29 10:30:00", refNow, "en"), "10:30");
  assert.equal(formatShortTime("2026-10-28 10:30:00", refNow, "zh-CN"), "昨天");
  assert.equal(formatShortTime("2026-10-28 10:30:00", refNow, "en"), "Yesterday");
  assert.equal(formatShortTime("2026-10-27 10:30:00", refNow, "zh-CN"), "周二");
  assert.equal(formatShortTime("2026-10-27 10:30:00", refNow, "en"), "Tue");
  assert.equal(formatShortTime("2026-05-15 10:30:00", refNow, "zh-CN"), "5月15日");
  assert.equal(formatShortTime("2026-05-15 10:30:00", refNow, "en"), "May 15");
  assert.equal(formatShortTime("2025-05-15 10:30:00", refNow, "zh-CN"), "2025/5/15");
  assert.equal(formatShortTime("2025-05-15 10:30:00", refNow, "en"), "May 15, 2025");

  // formatDayLabel
  assert.equal(formatDayLabel("2026-10-29", refNow, "zh-CN"), "今天");
  assert.equal(formatDayLabel("2026-10-29", refNow, "en"), "Today");
  assert.equal(formatDayLabel("2026-10-28", refNow, "zh-CN"), "昨天");
  assert.equal(formatDayLabel("2026-10-28", refNow, "en"), "Yesterday");
  assert.equal(formatDayLabel("2026-05-15", refNow, "zh-CN"), "5月15日 周五");
  assert.equal(formatDayLabel("2026-05-15", refNow, "en"), "May 15, Fri");
  assert.equal(formatDayLabel("2025-05-15", refNow, "zh-CN"), "2025年5月15日");
  assert.equal(formatDayLabel("2025-05-15", refNow, "en"), "May 15, 2025");

  // threadGroupLabel
  assert.equal(threadGroupLabel("2026-10-29 10:00:00", refNow, "zh-CN"), "今天");
  assert.equal(threadGroupLabel("2026-10-29 10:00:00", refNow, "en"), "Today");
  assert.equal(threadGroupLabel("2026-10-28 10:00:00", refNow, "zh-CN"), "昨天");
  assert.equal(threadGroupLabel("2026-10-28 10:00:00", refNow, "en"), "Yesterday");
  assert.equal(threadGroupLabel("2026-10-25 10:00:00", refNow, "zh-CN"), "本周");
  assert.equal(threadGroupLabel("2026-10-25 10:00:00", refNow, "en"), "This Week");
  assert.equal(threadGroupLabel("2026-10-10 10:00:00", refNow, "zh-CN"), "本月");
  assert.equal(threadGroupLabel("2026-10-10 10:00:00", refNow, "en"), "This Month");
  assert.equal(threadGroupLabel("2026-08-01 10:00:00", refNow, "zh-CN"), "更早");
  assert.equal(threadGroupLabel("2026-08-01 10:00:00", refNow, "en"), "Earlier");

  // describeSmsMode
  assert.equal(describeSmsMode("", "zh-CN"), "GSM-7 · 0 字");
  assert.equal(describeSmsMode("", "en"), "GSM-7 · 0 chars");
  assert.equal(describeSmsMode("Hello", "zh-CN"), "GSM-7 · 5 字 · 1 条");
  assert.equal(describeSmsMode("Hello", "en"), "GSM-7 · 5 chars · 1 segment");
  assert.equal(describeSmsMode("你好世界", "zh-CN"), "UCS-2 · 4 字 · 1 条");
  assert.equal(describeSmsMode("你好世界", "en"), "UCS-2 · 4 chars · 1 segment");
});
