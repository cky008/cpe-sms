// Lightweight, zero-dependency i18n manager for the Sujian (素笺) Web UI

import { DEFAULT_LOCALE, FLATTENED_LOCALES, SUPPORTED_LOCALES, type LocaleOption } from "./locales.generated.ts";

const STORAGE_KEY = "cpe_sms_locale";

let currentLocale = DEFAULT_LOCALE;
const listeners = new Set<(locale: string) => void>();

function detectInitialLocale(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED_LOCALES.some((l) => l.code === saved)) {
      return saved;
    }
    const navLang = navigator.language?.toLowerCase() ?? "";
    if (navLang.startsWith("zh")) {
      return "zh-CN";
    }
    for (const loc of SUPPORTED_LOCALES) {
      if (loc.code.toLowerCase() === navLang || navLang.startsWith(loc.code.toLowerCase())) {
        return loc.code;
      }
    }
    // Default to en if system language is not Chinese, else zh-CN
    return SUPPORTED_LOCALES.some((l) => l.code === "en") ? "en" : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function initI18n(): string {
  currentLocale = detectInitialLocale();
  document.documentElement.setAttribute("lang", currentLocale);
  applyI18nToDom();
  return currentLocale;
}

export function getLocale(): string {
  return currentLocale;
}

export function getSupportedLocales(): ReadonlyArray<LocaleOption> {
  return SUPPORTED_LOCALES;
}

export function setLocale(code: string): void {
  if (!SUPPORTED_LOCALES.some((l) => l.code === code)) return;
  currentLocale = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {}
  document.documentElement.setAttribute("lang", code);
  applyI18nToDom();
  for (const listener of listeners) {
    try {
      listener(code);
    } catch {}
  }
}

export function onLocaleChange(listener: (locale: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function t(key: string, params?: Record<string, string | number>): string {
  const currentDict = FLATTENED_LOCALES[currentLocale] ?? {};
  const enDict = FLATTENED_LOCALES.en ?? {};
  const defaultDict = FLATTENED_LOCALES[DEFAULT_LOCALE] ?? {};

  let template = currentDict[key] ?? enDict[key] ?? defaultDict[key] ?? key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replaceAll(`{${k}}`, String(v));
    }
  }

  return template;
}

export function applyI18nToDom(root: ParentNode = document): void {
  if (typeof document !== "undefined" && (root === document || !root)) {
    document.title = t("app.title");
  }

  // 1. Text content
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.getAttribute("data-i18n");
    if (key) {
      el.textContent = t(key);
    }
  }

  // 2. Placeholder
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-placeholder]")) {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) {
      el.placeholder = t(key);
    }
  }

  // 3. Title attribute
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const key = el.getAttribute("data-i18n-title");
    if (key) {
      el.title = t(key);
    }
  }

  // 4. Aria label
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-aria]")) {
    const key = el.getAttribute("data-i18n-aria");
    if (key) {
      el.setAttribute("aria-label", t(key));
    }
  }

  // 5. Tooltip data-tip
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-tip]")) {
    const key = el.getAttribute("data-i18n-tip");
    if (key) {
      el.setAttribute("data-tip", t(key));
    }
  }
}
