// Things 3-inspired daisyUI frontend controller for the H168-383 SMS Center (TypeScript)

import {
  ACCENT_PALETTE,
  THINGS_THEMES,
  describeSmsMode,
  escapeHtml,
  formatDayLabel,
  formatShortTime,
  initialsOf,
  isAccentId,
  isLikelyContactNameQuery,
  isThemeId,
  linkifyHtml,
  parseMsgTime,
  signalLevel,
  threadGroupLabel,
  type AccentId,
  type ThemeId,
} from "./ui-format.ts";

interface CountryOption {
  code: string;
  flag: string;
  nameZh: string;
}

interface SenderSummary {
  type: string;
  e164: string | null;
  dialable: boolean;
  flag: string;
  countryCode: string | null;
  countryZh: string;
  brandHint: string | null;
}

interface ContactBrief {
  id: string;
  name: string;
  note?: string;
}

interface ContactEntry extends ContactBrief {
  phones: string[];
}

interface UiSmsMessage {
  uid: string;
  index: number;
  phone: string;
  content: string;
  date: string;
  isUnread: boolean;
  direction: "in" | "out";
  verificationCode: string | null;
  onCpe: boolean;
  threadKey?: string;
  contact?: ContactBrief | null;
}

interface UiThread {
  threadKey: string;
  phone: string;
  replyPhone: string | null;
  dialable: boolean;
  sender: SenderSummary;
  contact: ContactBrief | null;
  displayName: string;
  unreadCount: number;
  totalCount: number;
  hasOtp: boolean;
  latestOtp: string | null;
  latestMessage: UiSmsMessage;
  matchedPreview?: string;
}

interface UiThreadDetail {
  threadKey: string;
  phone: string;
  replyPhone: string | null;
  dialable: boolean;
  sender: SenderSummary;
  contact: ContactBrief | null;
  messages: UiSmsMessage[];
}

interface CpeStats {
  localUnread: number;
  localInbox: number;
  localOutbox: number;
  localMax: number;
}

interface StatusApiResponse {
  ok: boolean;
  data: {
    device?: { deviceName?: string; marketingName?: string };
    network?: { operatorName?: string; numericPlmn?: string };
    signal?: { rsrp?: string; nrRsrp?: string };
    sms?: { localUnread?: number; localInbox?: number; localOutbox?: number; localMax?: number };
    archiveTotal?: number;
  };
}

interface ThreadsApiResponse {
  ok: boolean;
  data: {
    threads?: UiThread[];
    archiveTotal?: number;
    cpeStats?: CpeStats | null;
    contactsTotal?: number;
    defaultCountryCode?: string;
    countries?: CountryOption[];
  };
}

interface SyncApiResponse {
  ok: boolean;
  data: {
    syncedFromCpe: number;
    archiveTotal: number;
  };
}

interface PreviewApiResponse {
  ok: boolean;
  data: {
    recipient?: {
      ok: boolean;
      phone?: string;
      countryZh?: string;
      error?: string;
    };
  };
}

interface SendApiResponse {
  ok: boolean;
  data: {
    resolvedPhones?: string[];
  };
}

interface ContactsBookApiResponse {
  ok: boolean;
  data: {
    contacts?: ContactEntry[];
    total?: number;
  };
}

interface ImportVcfApiResponse {
  ok: boolean;
  data: {
    parsed: number;
    added: number;
    updated: number;
    total: number;
  };
}

type ThreadFilter = "all" | "unread" | "otp";

interface AppState {
  authenticated: boolean;
  defaultCountryCode: string;
  countries: CountryOption[];
  threads: UiThread[];
  contacts: ContactEntry[];
  selectedThreadKey: string | null;
  activeThread: UiThreadDetail | null;
  filter: ThreadFilter;
  search: string;
  archiveTotal: number;
  cpeStats: CpeStats | null;
  sse: EventSource | null;
}

const state: AppState = {
  authenticated: false,
  defaultCountryCode: "+353",
  countries: [],
  threads: [],
  contacts: [],
  selectedThreadKey: null,
  activeThread: null,
  filter: "all",
  search: "",
  archiveTotal: 0,
  cpeStats: null,
  sse: null,
};

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function icon(name: string, cls = ""): string {
  return `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

// =====================================================================
// Appearance (base theme + accent colour + follow-system)
// =====================================================================
interface Appearance {
  theme: ThemeId;
  accent: AccentId;
  followSystem: boolean;
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function loadAppearance(): Appearance {
  const theme = localStorage.getItem("cpe_sms_theme");
  const accent = localStorage.getItem("cpe_sms_accent");
  return {
    theme: isThemeId(theme) ? theme : "things-light",
    accent: isAccentId(accent) ? accent : "default",
    followSystem: localStorage.getItem("cpe_sms_follow_system") !== "0",
  };
}

const appearance = loadAppearance();

function effectiveTheme(): ThemeId {
  if (appearance.followSystem) return darkQuery.matches ? "things-dark" : "things-light";
  return appearance.theme;
}

function applyAppearance(animate: boolean): void {
  const root = document.documentElement;
  if (animate) {
    root.classList.add("theme-transition");
    window.setTimeout(() => root.classList.remove("theme-transition"), 360);
  }
  root.setAttribute("data-theme", effectiveTheme());
  root.setAttribute("data-accent", appearance.accent);
  localStorage.setItem("cpe_sms_theme", appearance.theme);
  localStorage.setItem("cpe_sms_accent", appearance.accent);
  localStorage.setItem("cpe_sms_follow_system", appearance.followSystem ? "1" : "0");
  renderAppearancePicker();
}

function renderAppearancePicker(): void {
  const current = effectiveTheme();
  byId("themeOptions").innerHTML = THINGS_THEMES.map(
    (t) => `
      <button type="button" data-theme-option="${t.id}" class="theme-card ${t.id === current ? "is-selected" : ""}">
        <div class="preview" data-theme="${t.id}">
          <div class="w-[34%] bg-base-200 p-1.5 space-y-1">
            <div class="h-1 w-3/4 rounded-full bg-primary"></div>
            <div class="h-1 rounded-full bg-base-content/20"></div>
            <div class="h-1 w-2/3 rounded-full bg-base-content/20"></div>
          </div>
          <div class="flex-1 bg-base-100 p-1.5 flex flex-col gap-1">
            <div class="h-1.5 w-2/3 rounded-full bg-base-content/70"></div>
            <div class="h-1 w-5/6 rounded-full bg-base-content/15"></div>
            <div class="mt-auto self-end h-2.5 w-7 rounded-full bg-primary"></div>
          </div>
        </div>
        <span>${t.label}</span>
      </button>`
  ).join("");

  const activeAccentMeta = ACCENT_PALETTE.find((a) => a.id === appearance.accent) ?? ACCENT_PALETTE[0];
  byId("accentActiveLabel").textContent = activeAccentMeta.label;

  byId("accentOptions").innerHTML = ACCENT_PALETTE.map((a) => {
    const isAuto = a.id === "default";
    const styleAttr = isAuto ? "" : `style="color:${a.color}"`;
    return `
      <div class="tooltip" data-tip="${a.label}">
        <button type="button" data-accent-option="${a.id}" aria-label="${a.label}"
          class="swatch ${isAuto ? "swatch-auto" : ""} ${a.id === appearance.accent ? "is-selected" : ""}" ${styleAttr}>
          ${icon("check")}
        </button>
      </div>`;
  }).join("");

  byId<HTMLInputElement>("followSystemToggle").checked = appearance.followSystem;
}

function openAppearanceModal(): void {
  renderAppearancePicker();
  byId<HTMLDialogElement>("appearanceModal").showModal();
}

byId("themeOptions").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-theme-option]");
  const id = btn?.getAttribute("data-theme-option") ?? null;
  if (!isThemeId(id)) return;
  appearance.theme = id;
  appearance.followSystem = false;
  applyAppearance(true);
});

byId("accentOptions").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-accent-option]");
  const id = btn?.getAttribute("data-accent-option") ?? null;
  if (!isAccentId(id)) return;
  appearance.accent = id;
  applyAppearance(true);
});

byId<HTMLInputElement>("followSystemToggle").addEventListener("change", (e) => {
  appearance.followSystem = (e.target as HTMLInputElement).checked;
  if (!appearance.followSystem) appearance.theme = darkQuery.matches ? "things-dark" : "things-light";
  applyAppearance(true);
});

darkQuery.addEventListener("change", () => {
  if (appearance.followSystem) applyAppearance(true);
});

byId("appearanceBtn").addEventListener("click", openAppearanceModal);
byId("loginAppearanceBtn").addEventListener("click", openAppearanceModal);
byId("mobileAppearanceBtn").addEventListener("click", openAppearanceModal);

applyAppearance(false);

document.querySelectorAll<HTMLElement>("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", () => btn.closest("dialog")?.close());
});

// =====================================================================
// UI Helpers & Network
// =====================================================================
function avatarHtml(opts: {
  name: string;
  hasContact: boolean;
  senderType: string;
  size: string;
  extra?: string;
}): string {
  const isBrand = ["alphanumeric", "shortcode", "gateway"].includes(opts.senderType);
  const content = opts.hasContact || isBrand ? escapeHtml(initialsOf(opts.name)) : icon("user", "text-[1.1em]");
  return `<div class="avatar-ph ${isBrand ? "is-brand" : ""} ${opts.size} ${opts.extra ?? ""}">${content}</div>`;
}

function showToast(message: string, type: "info" | "success" | "error" | "warning" = "info"): void {
  const container = byId("toastContainer");
  const iconName = type === "success" ? "check" : type === "error" ? "x" : type === "warning" ? "alert" : "info";
  const color =
    type === "success" ? "text-success" : type === "error" ? "text-error" : type === "warning" ? "text-warning" : "text-info";
  const el = document.createElement("div");
  el.className = "toast-item pointer-events-auto";
  el.innerHTML = `${icon(iconName, `text-base ${color}`)}<span>${escapeHtml(message)}</span>`;
  container.appendChild(el);
  window.setTimeout(() => {
    el.classList.add("is-leaving");
    window.setTimeout(() => el.remove(), 260);
  }, 3400);
}

async function copyText(text: string, label = "已复制"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} ${text}`, "success");
    return true;
  } catch {
    showToast("复制失败，请手动选中复制", "warning");
    return false;
  }
}

function flashCopied(btn: HTMLElement): void {
  btn.classList.add("is-copied");
  const hint = btn.querySelector<HTMLElement>("[data-copy-hint]");
  const prev = hint?.textContent ?? "";
  if (hint) hint.textContent = "已复制";
  window.setTimeout(() => {
    btn.classList.remove("is-copied");
    if (hint) hint.textContent = prev;
  }, 1600);
}

function otpChipHtml(code: string, attr: string, withHint: boolean): string {
  return `<button type="button" ${attr}="${escapeHtml(code)}" class="otp-chip" title="点击复制验证码">
    ${icon("key", "text-[0.95em]")}<span class="code">${escapeHtml(code)}</span>${
      withHint ? `<span data-copy-hint class="text-base-content/45">复制</span>` : ""
    }</button>`;
}

function restartAnimation(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

async function apiFetch<T = { ok: boolean }>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as {
    ok?: boolean;
    error?: string;
  };
  if (res.status === 401 && path !== "/api/auth/login") {
    showLoginScreen();
    throw new Error("登录会话已过期");
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data as T;
}

// =====================================================================
// Views & Auth
// =====================================================================
const loginView = byId("loginView");
const appView = byId("appView");
const navDrawer = byId<HTMLInputElement>("navDrawer");

function showLoginScreen(): void {
  state.authenticated = false;
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  appView.classList.add("hidden");
  loginView.classList.remove("hidden");
  byId<HTMLInputElement>("loginPassword").focus();
}

async function enterWorkspace(): Promise<void> {
  state.authenticated = true;
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");

  listAnimateNext = true;
  await Promise.all([loadThreads(), loadContactsBook(), refreshDeviceStatus()]);
  connectSse();

  if ("Notification" in window && Notification.permission === "default") {
    document.body.addEventListener(
      "click",
      () => {
        if (Notification.permission === "default") {
          Notification.requestPermission().catch(() => {});
        }
      },
      { once: true }
    );
  }
}

byId<HTMLFormElement>("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pwdInput = byId<HTMLInputElement>("loginPassword");
  const errEl = byId("loginError");
  const btn = byId<HTMLButtonElement>("loginSubmitBtn");
  errEl.classList.add("hidden");
  btn.disabled = true;
  btn.innerHTML = `<span class="loading loading-spinner loading-sm"></span>`;

  try {
    const res = await apiFetch<{ ok: boolean; defaultCountryCode?: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: pwdInput.value }),
    });
    if (res.defaultCountryCode) state.defaultCountryCode = res.defaultCountryCode;
    pwdInput.value = "";
    await enterWorkspace();
  } catch (err) {
    errEl.textContent = err instanceof Error ? err.message : String(err);
    errEl.classList.remove("hidden");
    restartAnimation(byId("loginForm"), "anim-pop-in");
  } finally {
    btn.disabled = false;
    btn.textContent = "登录";
  }
});

byId<HTMLButtonElement>("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  showLoginScreen();
});

// =====================================================================
// Real-time SSE
// =====================================================================
function setLiveIndicator(live: boolean): void {
  byId("sseDot").classList.toggle("is-live", live);
  byId("sseLabel").textContent = live ? "实时" : "重连中";
}

function connectSse(): void {
  if (state.sse) state.sse.close();
  const es = new EventSource("/api/events");
  state.sse = es;

  es.addEventListener("open", () => setLiveIndicator(true));
  es.addEventListener("error", () => setLiveIndicator(false));

  es.addEventListener("sms:new", (ev) => {
    void (async () => {
      const msg = JSON.parse((ev as MessageEvent<string>).data) as UiSmsMessage;
      const who = msg.contact?.name || msg.phone;
      showToast(msg.verificationCode ? `${who} · 验证码 ${msg.verificationCode}` : `新信息 · ${who}`, "info");

      if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        new Notification(`新短信 · ${who}`, {
          body: msg.verificationCode ? `验证码 ${msg.verificationCode} · ${msg.content}` : msg.content,
        });
      }

      await loadThreads();
      if (state.selectedThreadKey && state.selectedThreadKey === msg.threadKey) {
        await refreshActiveThread({ preserveScroll: false });
      }
    })();
  });

  es.addEventListener("sms:sent", (ev) => {
    void (async () => {
      const msg = JSON.parse((ev as MessageEvent<string>).data) as UiSmsMessage;
      await loadThreads();
      if (state.selectedThreadKey && state.selectedThreadKey === msg.threadKey) {
        await refreshActiveThread({ preserveScroll: false });
      }
    })();
  });

  const refreshAll = (): void => {
    void (async () => {
      await loadThreads();
      await refreshActiveThread({ preserveScroll: true });
    })();
  };

  es.addEventListener("sms:updated", refreshAll);

  es.addEventListener("sms:sync", (ev) => {
    const summary = JSON.parse((ev as MessageEvent<string>).data) as {
      archiveTotal: number;
      cpeStats: CpeStats;
    };
    state.archiveTotal = summary.archiveTotal;
    state.cpeStats = summary.cpeStats;
    refreshAll();
  });

  es.addEventListener("contacts:updated", () => {
    void (async () => {
      await loadContactsBook();
      refreshAll();
    })();
  });

  es.addEventListener("status:update", (ev) => {
    const st = JSON.parse((ev as MessageEvent<string>).data) as { unreadMessages: number };
    if (state.cpeStats) {
      state.cpeStats.localUnread = st.unreadMessages;
      updateFooterStats();
    }
  });
}

// =====================================================================
// Device status & full sync
// =====================================================================
async function refreshDeviceStatus(): Promise<void> {
  try {
    const res = await apiFetch<StatusApiResponse>("/api/status");
    const d = res.data;
    const op = d.network?.operatorName || d.network?.numericPlmn || "未知运营商";
    const nr = d.signal?.nrRsrp;
    const lte = d.signal?.rsrp;
    const sigText = nr ? `5G ${nr}` : lte ? `4G ${lte}` : "";

    byId("deviceName").textContent = d.device?.marketingName || d.device?.deviceName || "H168-383";
    byId("signalSubtitle").textContent = [op, sigText].filter(Boolean).join(" · ");
    byId("signalBars").setAttribute("data-level", String(signalLevel(nr || lte)));

    state.cpeStats = {
      localUnread: d.sms?.localUnread ?? 0,
      localInbox: d.sms?.localInbox ?? 0,
      localOutbox: d.sms?.localOutbox ?? 0,
      localMax: d.sms?.localMax ?? 500,
    };
    state.archiveTotal = d.archiveTotal ?? state.archiveTotal;
    updateFooterStats();
  } catch {
    byId("signalSubtitle").textContent = "设备状态暂不可用";
  }
}

async function triggerFullHistorySync(): Promise<void> {
  const btn = byId<HTMLButtonElement>("syncAllBtn");
  const syncIcon = byId("syncIcon");
  btn.disabled = true;
  syncIcon.classList.add("animate-spin");

  try {
    const res = await apiFetch<SyncApiResponse>("/api/archive/sync", { method: "POST" });
    showToast(`已同步 ${res.data.syncedFromCpe} 条，本地共归档 ${res.data.archiveTotal} 条`, "success");
    await Promise.all([loadThreads(), refreshDeviceStatus()]);
    await refreshActiveThread({ preserveScroll: true });
  } catch (err) {
    showToast(`同步失败：${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    btn.disabled = false;
    syncIcon.classList.remove("animate-spin");
  }
}

byId("syncAllBtn").addEventListener("click", () => void triggerFullHistorySync());
byId("emptySyncBtn").addEventListener("click", () => void triggerFullHistorySync());

function updateFooterStats(): void {
  const archiveSpan = byId("archiveFooterText").querySelector("span");
  if (archiveSpan) archiveSpan.textContent = `本地加密归档 ${state.archiveTotal} 条`;
  if (state.cpeStats) {
    const { localInbox, localOutbox, localMax } = state.cpeStats;
    const used = localInbox + localOutbox;
    byId("cpeCapFooterText").textContent = `${used} / ${localMax}`;
    const pct = localMax > 0 ? Math.min(100, (used / localMax) * 100) : 0;
    byId("cpeCapBar").style.width = `${pct.toFixed(1)}%`;
  }
}

// =====================================================================
// Thread list
// =====================================================================
const FILTER_META: Record<ThreadFilter, { title: string; icon: string; color: string; empty: string }> = {
  all: { title: "收件箱", icon: "inbox", color: "text-primary", empty: "还没有任何对话" },
  unread: { title: "未读", icon: "unread", color: "text-warning", empty: "全部已读，干得漂亮" },
  otp: { title: "验证码", icon: "key", color: "text-success", empty: "没有包含验证码的短信" },
};

let listAnimateNext = true;
const seenThreadLatest = new Map<string, string>();

async function loadThreads(): Promise<void> {
  const params = new URLSearchParams({ filter: state.filter, search: state.search });
  const res = await apiFetch<ThreadsApiResponse>(`/api/archive/threads?${params.toString()}`);
  const d = res.data;

  state.threads = d.threads ?? [];
  state.archiveTotal = d.archiveTotal ?? 0;
  state.cpeStats = d.cpeStats ?? state.cpeStats;
  if (d.defaultCountryCode) state.defaultCountryCode = d.defaultCountryCode;
  if (Array.isArray(d.countries) && d.countries.length > 0 && state.countries.length === 0) {
    state.countries = d.countries;
    populateCountrySelect();
  }

  byId("contactsCountBadge").textContent = d.contactsTotal ? String(d.contactsTotal) : "";
  if (state.filter === "all" && !state.search) {
    const unread = state.threads.reduce((acc, t) => acc + t.unreadCount, 0);
    byId("navCountAll").textContent = state.threads.length ? String(state.threads.length) : "";
    byId("navCountUnread").textContent = unread > 0 ? String(unread) : "";
    const otp = state.threads.filter((t) => t.hasOtp).length;
    byId("navCountOtp").textContent = otp > 0 ? String(otp) : "";
  }
  updateFooterStats();
  renderThreadList();
}

function renderThreadList(): void {
  const container = byId("threadList");
  const meta = FILTER_META[state.filter];
  byId("listCount").textContent = state.threads.length ? String(state.threads.length) : "";

  if (state.threads.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center justify-center text-center gap-3 pt-20 px-6 anim-fade">
        ${icon(meta.icon, "text-4xl text-base-content/15")}
        <div class="text-sm text-base-content/55">${state.search ? "没有匹配的结果" : meta.empty}</div>
        ${
          state.filter === "all" && !state.search
            ? `<div class="text-xs text-base-content/40">首次使用可在左下角「同步历史」拉取 CPE 中的旧短信</div>`
            : ""
        }
      </div>`;
    listAnimateNext = false;
    return;
  }

  const animateAll = listAnimateNext;
  listAnimateNext = false;
  const firstRender = seenThreadLatest.size === 0;
  let i = 0;
  let lastGroup = "";
  const html: string[] = [];

  for (const t of state.threads) {
    const group = threadGroupLabel(t.latestMessage?.date);
    if (group !== lastGroup) {
      html.push(`<div class="section-head ${animateAll ? "anim-rise" : ""}" style="--i:${i}"><span>${group}</span></div>`);
      lastGroup = group;
    }

    const latestUid = t.latestMessage?.uid ?? "";
    const prevUid = seenThreadLatest.get(t.threadKey);
    const isNewActivity = !firstRender && !animateAll && prevUid !== latestUid;
    seenThreadLatest.set(t.threadKey, latestUid);

    const active = t.threadKey === state.selectedThreadKey;
    const unread = t.unreadCount > 0;
    const preview = (t.matchedPreview || t.latestMessage?.content || "").replace(/\s+/g, " ");
    const animCls = animateAll ? "anim-rise" : isNewActivity ? (prevUid === undefined ? "anim-rise" : "anim-flash") : "";

    html.push(`
      <div role="button" tabindex="0" data-thread-key="${escapeHtml(t.threadKey)}"
        class="thread-row ${active ? "is-active" : ""} ${animCls}" style="--i:${i}">
        ${avatarHtml({ name: t.displayName, hasContact: Boolean(t.contact), senderType: t.sender.type, size: "size-10 text-sm" })}
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-[15px] ${unread ? "font-bold" : "font-semibold"}">${escapeHtml(t.displayName)}</span>
            <span class="ml-auto shrink-0 text-xs tabular-nums ${unread ? "text-primary font-medium" : "text-base-content/40"}">${escapeHtml(
              formatShortTime(t.latestMessage?.date)
            )}</span>
          </div>
          <div class="mt-0.5 flex items-start gap-2">
            <p class="flex-1 text-[13px] leading-snug line-clamp-2 ${unread ? "text-base-content/80" : "text-base-content/50"}">${
              t.latestMessage?.direction === "out" ? `<span class="text-base-content/40">我：</span>` : ""
            }${escapeHtml(preview)}</p>
            ${
              unread
                ? t.unreadCount > 1
                  ? `<span class="badge badge-primary badge-sm rounded-full font-semibold tabular-nums mt-0.5">${t.unreadCount}</span>`
                  : `<span class="unread-dot mt-1.5"></span>`
                : ""
            }
          </div>
          ${t.latestOtp ? `<div class="mt-1.5">${otpChipHtml(t.latestOtp, "data-copy-otp", false)}</div>` : ""}
        </div>
      </div>`);
    i += 1;
  }

  container.innerHTML = html.join("");
  if (animateAll) container.scrollTop = 0;
}

byId("threadList").addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const otpBtn = target.closest<HTMLElement>("[data-copy-otp]");
  if (otpBtn) {
    e.stopPropagation();
    const code = otpBtn.getAttribute("data-copy-otp") || "";
    void copyText(code, "验证码已复制").then((ok) => ok && flashCopied(otpBtn));
    return;
  }
  const row = target.closest<HTMLElement>("[data-thread-key]");
  const key = row?.getAttribute("data-thread-key");
  if (key) void openThread(key);
});

byId("threadList").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-thread-key]");
  const key = row?.getAttribute("data-thread-key");
  if (key) {
    e.preventDefault();
    void openThread(key);
  }
});

let searchTimer: ReturnType<typeof setTimeout> | null = null;
byId<HTMLInputElement>("searchInput").addEventListener("input", (e) => {
  state.search = (e.target as HTMLInputElement).value;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    listAnimateNext = true;
    void loadThreads();
  }, 180);
});

function setFilter(f: ThreadFilter): void {
  state.filter = f;
  const meta = FILTER_META[f];
  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.getAttribute("data-filter") === f);
  });
  byId("listTitle").textContent = meta.title;
  const titleIcon = byId("listTitleIcon");
  titleIcon.setAttribute("class", `ico text-[1.4rem] ${meta.color} transition-colors anim-pop-in`);
  titleIcon.querySelector("use")?.setAttribute("href", `#i-${meta.icon}`);
  navDrawer.checked = false;
  listAnimateNext = true;
  void loadThreads();
}

document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const f = btn.getAttribute("data-filter");
    setFilter(f === "unread" || f === "otp" ? f : "all");
  });
});

// =====================================================================
// Conversation view
// =====================================================================
const chatPane = byId("chatPane");
const messagesList = byId("messagesList");
let renderedThreadKey: string | null = null;
const renderedMsgUids = new Set<string>();

function setMobileChatVisible(visible: boolean): void {
  appView.setAttribute("data-mobile-view", visible ? "chat" : "list");
  if (visible && window.matchMedia("(max-width: 767.98px)").matches) {
    restartAnimation(chatPane, "anim-slide");
  }
}

byId<HTMLButtonElement>("mobileBackBtn").addEventListener("click", () => setMobileChatVisible(false));

async function openThread(threadKey: string): Promise<void> {
  state.selectedThreadKey = threadKey;
  document.querySelectorAll<HTMLElement>("#threadList [data-thread-key]").forEach((el) => {
    el.classList.toggle("is-active", el.getAttribute("data-thread-key") === threadKey);
  });
  setMobileChatVisible(true);
  await refreshActiveThread({ preserveScroll: false });
}

async function refreshActiveThread(opts: { preserveScroll: boolean }): Promise<void> {
  const threadKey = state.selectedThreadKey;
  if (!threadKey) return;

  const res = await apiFetch<{ ok: boolean; data: UiThreadDetail | null }>(
    `/api/archive/thread?key=${encodeURIComponent(threadKey)}`
  );
  const detail = res.data;
  if (!detail || state.selectedThreadKey !== threadKey) return;
  state.activeThread = detail;

  const isSwitch = renderedThreadKey !== threadKey;
  if (isSwitch) {
    renderedThreadKey = threadKey;
    renderedMsgUids.clear();
  }

  byId("emptyChatState").classList.add("hidden");
  const container = byId("activeChatContainer");
  container.classList.remove("hidden");
  if (isSwitch) restartAnimation(container, "anim-fade");

  renderChatHeader(detail);
  renderComposerState(detail);
  renderMessages(detail, { isSwitch, preserveScroll: opts.preserveScroll });
}

function renderChatHeader(detail: UiThreadDetail): void {
  const s = detail.sender;
  const title = detail.contact
    ? detail.contact.name
    : s.brandHint && s.type !== "alphanumeric"
      ? `${s.e164 || detail.phone} (${s.brandHint})`
      : s.e164 || detail.phone;
  byId("chatHeaderTitle").textContent = title;

  const avatarSlot = byId("chatHeaderAvatar");
  avatarSlot.outerHTML = avatarHtml({
    name: title,
    hasContact: Boolean(detail.contact),
    senderType: s.type,
    size: "size-10 text-sm",
    extra: "is-accent",
  }).replace('class="avatar-ph', 'id="chatHeaderAvatar" class="avatar-ph');

  const country = s.countryCode ? `${s.countryZh} ${s.countryCode}` : s.countryZh;
  const parts = detail.contact
    ? [s.e164 || detail.phone, country, detail.contact.note || ""]
    : [s.e164 && s.e164 !== title ? s.e164 : "", country];
  parts.push(`${detail.messages.length} 条信息`);
  byId("chatHeaderSub").textContent = parts.filter(Boolean).join(" · ");

  const unreadIndices = detail.messages.filter((m) => m.isUnread && m.onCpe && m.index > 0).map((m) => m.index);
  const markBtn = byId<HTMLButtonElement>("markThreadReadBtn");
  if (unreadIndices.length > 0) {
    markBtn.classList.remove("hidden");
    byId("markThreadReadLabel").textContent = `标为已读 · ${unreadIndices.length}`;
    markBtn.onclick = async () => {
      markBtn.disabled = true;
      try {
        await apiFetch("/api/read", { method: "POST", body: JSON.stringify({ indices: unreadIndices }) });
        showToast(`已将 ${unreadIndices.length} 条标为已读`, "success");
        await Promise.all([loadThreads(), refreshActiveThread({ preserveScroll: true })]);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      } finally {
        markBtn.disabled = false;
      }
    };
  } else {
    markBtn.classList.add("hidden");
  }
}

function renderComposerState(detail: UiThreadDetail): void {
  const replyForm = byId("replyForm");
  const banner = byId("nonDialableBanner");
  if (detail.dialable && detail.replyPhone) {
    banner.classList.add("hidden");
    replyForm.classList.remove("hidden");
    byId("replyTargetHint").textContent = `发送至 ${detail.replyPhone}`;
  } else {
    replyForm.classList.add("hidden");
    banner.classList.remove("hidden");
  }
}

function renderMessages(detail: UiThreadDetail, opts: { isSwitch: boolean; preserveScroll: boolean }): void {
  const prevScroll = messagesList.scrollTop;
  const wasNearBottom = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 120;
  const msgs = detail.messages;
  const GROUP_GAP_MS = 5 * 60 * 1000;
  const html: string[] = [`<div class="mx-auto max-w-3xl px-5 md:px-8 pt-2 pb-6">`];
  let lastDay = "";

  msgs.forEach((m, idx) => {
    const day = m.date.split(" ")[0] ?? "";
    if (day !== lastDay) {
      html.push(`<div class="day-sep">${escapeHtml(formatDayLabel(day))}</div>`);
      lastDay = day;
    }
    const prev = msgs[idx - 1];
    const next = msgs[idx + 1];
    const sameAsPrev =
      prev !== undefined &&
      prev.direction === m.direction &&
      (prev.date.split(" ")[0] ?? "") === day &&
      parseMsgTime(m.date) - parseMsgTime(prev.date) < GROUP_GAP_MS;
    const sameAsNext =
      next !== undefined &&
      next.direction === m.direction &&
      (next.date.split(" ")[0] ?? "") === day &&
      parseMsgTime(next.date) - parseMsgTime(m.date) < GROUP_GAP_MS;

    const isOut = m.direction === "out";
    const isNew = !opts.isSwitch && !renderedMsgUids.has(m.uid);
    renderedMsgUids.add(m.uid);
    const localOnly = !m.onCpe && m.index > 0;
    const showMeta = !sameAsNext || localOnly || m.isUnread || Boolean(m.verificationCode);

    const metaBits = [`<time>${escapeHtml(m.date.split(" ")[1]?.slice(0, 5) ?? "")}</time>`];
    if (m.isUnread) metaBits.push(`<span class="text-primary font-medium">未读</span>`);
    if (localOnly) metaBits.push(`<span>仅本地归档</span>`);

    const delBtn = `
      <button type="button" data-del-uid="${escapeHtml(m.uid)}" data-del-index="${m.onCpe ? m.index : 0}"
        class="reveal-on-hover btn btn-ghost btn-xs btn-circle text-base-content/40 hover:text-error shrink-0" title="删除" aria-label="删除">
        ${icon("trash", "text-sm")}
      </button>`;

    html.push(`
      <div class="group flex flex-col ${isOut ? "items-end" : "items-start"} ${sameAsPrev ? "mt-0.5" : "mt-3"} ${
        isNew ? `anim-pop-in ${isOut ? "from-right" : "from-left"}` : ""
      }" data-msg-uid="${escapeHtml(m.uid)}">
        <div class="flex items-center gap-1.5 max-w-[85%] sm:max-w-[72%] ${isOut ? "flex-row-reverse" : ""}">
          <div class="bubble ${isOut ? "bubble-out" : "bubble-in"} ${sameAsPrev ? "join-top" : ""} ${
            sameAsNext ? "join-bottom" : ""
          }" title="${escapeHtml(m.date)}">${linkifyHtml(m.content)}</div>
          ${delBtn}
        </div>
        ${m.verificationCode ? `<div class="mt-1.5">${otpChipHtml(m.verificationCode, "data-msg-otp", true)}</div>` : ""}
        ${showMeta ? `<div class="mt-1 px-1.5 flex items-center gap-1.5 text-[11px] text-base-content/40">${metaBits.join("<span>·</span>")}</div>` : ""}
      </div>`);
  });
  html.push(`</div>`);
  messagesList.innerHTML = html.join("");

  if (opts.isSwitch || !opts.preserveScroll) {
    if (!opts.isSwitch && wasNearBottom) {
      messagesList.scrollTo({ top: messagesList.scrollHeight, behavior: "smooth" });
    } else {
      messagesList.scrollTop = messagesList.scrollHeight;
    }
  } else {
    messagesList.scrollTop = prevScroll;
  }
}

messagesList.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const otpBtn = target.closest<HTMLElement>("[data-msg-otp]");
  if (otpBtn) {
    const code = otpBtn.getAttribute("data-msg-otp") || "";
    void copyText(code, "验证码已复制").then((ok) => ok && flashCopied(otpBtn));
    return;
  }
  const delBtn = target.closest<HTMLElement>("[data-del-uid]");
  if (delBtn) void deleteMessage(delBtn);
});

async function deleteMessage(btn: HTMLElement): Promise<void> {
  const uid = btn.getAttribute("data-del-uid") || "";
  const idx = Number(btn.getAttribute("data-del-index"));
  const msg = idx > 0 ? "确定从 CPE 路由器和本地历史中删除这条短信吗？" : "确定从本地归档中删除这条短信吗？";
  if (!confirm(msg)) return;
  try {
    await apiFetch("/api/delete", {
      method: "POST",
      body: JSON.stringify({
        indices: idx > 0 ? [idx] : [],
        uids: [uid],
        deleteFromCpe: idx > 0,
        deleteFromArchive: true,
      }),
    });
    const row = btn.closest<HTMLElement>("[data-msg-uid]");
    if (row) {
      row.style.transition = "opacity .2s ease, transform .2s ease";
      row.style.opacity = "0";
      row.style.transform = "scale(.96)";
      await new Promise((r) => setTimeout(r, 200));
    }
    showToast("已删除", "success");
    await Promise.all([loadThreads(), refreshActiveThread({ preserveScroll: true })]);
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), "error");
  }
}

byId("editNicknameBtn").addEventListener("click", () => {
  if (!state.activeThread) return;
  openContactsModal({
    phone: state.activeThread.sender.e164 || state.activeThread.phone,
    name: state.activeThread.contact?.name || "",
    note: state.activeThread.contact?.note || "",
  });
});

// Reply composer
const replyTextarea = byId<HTMLTextAreaElement>("replyTextarea");
const replySendBtn = byId<HTMLButtonElement>("replySendBtn");

function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

function syncReplyComposer(): void {
  autoGrow(replyTextarea);
  const hasText = replyTextarea.value.trim().length > 0;
  replySendBtn.disabled = !hasText;
  byId("replyEncodingHint").textContent = hasText ? describeSmsMode(replyTextarea.value) : "";
}

replyTextarea.addEventListener("input", syncReplyComposer);
replyTextarea.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    byId<HTMLFormElement>("replyForm").requestSubmit();
  }
});

byId<HTMLFormElement>("replyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.activeThread?.replyPhone) return;
  const text = replyTextarea.value.trim();
  if (!text) return;

  replySendBtn.disabled = true;
  replySendBtn.innerHTML = `<span class="loading loading-spinner loading-xs"></span>`;

  try {
    await apiFetch("/api/send", {
      method: "POST",
      body: JSON.stringify({
        phone: state.activeThread.replyPhone,
        countryCode: state.defaultCountryCode,
        content: text,
      }),
    });
    replyTextarea.value = "";
    showToast(`已发送至 ${state.activeThread.replyPhone}`, "success");
    await Promise.all([loadThreads(), refreshActiveThread({ preserveScroll: false })]);
  } catch (err) {
    showToast(`发送失败：${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    replySendBtn.innerHTML = icon("arrow-up", "text-base");
    replySendBtn.querySelector("svg")?.setAttribute("style", "stroke-width:2.25");
    syncReplyComposer();
  }
});

// =====================================================================
// New message modal
// =====================================================================
function populateCountrySelect(): void {
  const sel = byId<HTMLSelectElement>("newSmsCountrySelect");
  sel.innerHTML = state.countries
    .map(
      (c) =>
        `<option value="${escapeHtml(c.code)}" ${c.code === state.defaultCountryCode ? "selected" : ""}>${escapeHtml(
          c.nameZh
        )} ${escapeHtml(c.code)}</option>`
    )
    .join("");
}

function openNewSmsModal(): void {
  byId<HTMLDialogElement>("newSmsModal").showModal();
  updateNewSmsPreview();
  setTimeout(() => byId<HTMLInputElement>("newSmsPhoneInput").focus(), 60);
}

byId("newSmsBtn").addEventListener("click", openNewSmsModal);
byId("emptyNewSmsBtn").addEventListener("click", openNewSmsModal);

let previewTimer: ReturnType<typeof setTimeout> | null = null;

function pickSuggestedPhone(phone: string): void {
  byId<HTMLInputElement>("newSmsPhoneInput").value = phone;
  byId("newSmsContactSuggestions").classList.add("hidden");
  updateNewSmsPreview();
  byId<HTMLTextAreaElement>("newSmsContentInput").focus();
}

function updateNewSmsPreview(): void {
  const countryCode = byId<HTMLSelectElement>("newSmsCountrySelect").value || state.defaultCountryCode;
  const rawPhone = byId<HTMLInputElement>("newSmsPhoneInput").value.trim();
  const content = byId<HTMLTextAreaElement>("newSmsContentInput").value;
  const sugBox = byId("newSmsContactSuggestions");
  const prevBox = byId("newSmsResolvedPreview");

  byId("newSmsModeHint").textContent = describeSmsMode(content);

  if (!rawPhone) {
    sugBox.classList.add("hidden");
    prevBox.innerHTML = `${icon("info")}<span>默认区号 ${escapeHtml(countryCode)}，可直接输入本地号码或带 + 的国际号码</span>`;
    return;
  }

  const q = rawPhone.toLowerCase();
  const hits = state.contacts
    .filter((c) => c.name.toLowerCase().includes(q) || c.phones.some((p) => p.toLowerCase().includes(q)))
    .slice(0, 5);

  const showSuggestions = hits.length > 0 && !hits.some((c) => c.phones.includes(rawPhone));
  if (showSuggestions) {
    sugBox.classList.remove("hidden");
    sugBox.innerHTML = hits
      .flatMap((c) =>
        c.phones.slice(0, 2).map(
          (ph, idx) => `
          <button type="button" data-pick-phone="${escapeHtml(ph)}"
            class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-left transition-colors anim-fade ${
              idx === 0 && c === hits[0] ? "bg-primary/10 hover:bg-primary/15" : "hover:bg-base-200"
            }">
            ${avatarHtml({ name: c.name, hasContact: true, senderType: "national", size: "size-7 text-[11px]", extra: idx === 0 && c === hits[0] ? "is-accent" : "" })}
            <span class="text-sm font-medium truncate">${escapeHtml(c.name)}</span>
            <span class="ml-auto text-xs font-mono muted">${escapeHtml(ph)}</span>
          </button>`
        )
      )
      .join("");
  } else {
    sugBox.classList.add("hidden");
  }

  // When searching by contact name, guide calmly instead of flashing an invalid-phone warning
  if (isLikelyContactNameQuery(rawPhone)) {
    if (previewTimer) clearTimeout(previewTimer);
    if (hits.length > 0) {
      prevBox.innerHTML = `${icon("check", "text-primary")}<span>按回车选择「${escapeHtml(hits[0]!.name)}」，或点击上方联系人</span>`;
    } else {
      prevBox.innerHTML = `${icon("info")}<span>未找到匹配的联系人，请输入完整手机号码</span>`;
    }
    return;
  }

  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    void (async () => {
      try {
        const res = await apiFetch<PreviewApiResponse>("/api/sms/preview", {
          method: "POST",
          body: JSON.stringify({ phone: rawPhone, countryCode, content }),
        });
        const r = res.data.recipient;
        if (r?.ok && r.phone) {
          prevBox.innerHTML = `${icon("check", "text-success")}<span>发送至 ${escapeHtml(r.countryZh ?? "")} · <span class="font-mono font-semibold text-base-content/85">${escapeHtml(
            r.phone
          )}</span></span>`;
        } else {
          prevBox.innerHTML = `${icon("alert", "text-warning")}<span class="text-warning">${escapeHtml(
            r?.error || "请输入有效号码或选择联系人"
          )}</span>`;
        }
      } catch {
        // ignore transient preview errors
      }
    })();
  }, 150);
}

byId("newSmsContactSuggestions").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-pick-phone]");
  const picked = b?.getAttribute("data-pick-phone");
  if (picked) pickSuggestedPhone(picked);
});

byId("newSmsPhoneInput").addEventListener("keydown", (e) => {
  const ke = e as KeyboardEvent;
  if (ke.key === "Enter" || ke.key === "Tab") {
    const firstSuggestion = byId("newSmsContactSuggestions").querySelector<HTMLElement>("[data-pick-phone]");
    const raw = byId<HTMLInputElement>("newSmsPhoneInput").value;
    const phone = firstSuggestion?.getAttribute("data-pick-phone");
    if (phone && !byId("newSmsContactSuggestions").classList.contains("hidden") && isLikelyContactNameQuery(raw)) {
      ke.preventDefault();
      pickSuggestedPhone(phone);
    }
  }
});

byId("newSmsCountrySelect").addEventListener("change", updateNewSmsPreview);
byId("newSmsPhoneInput").addEventListener("input", updateNewSmsPreview);
byId("newSmsContentInput").addEventListener("input", updateNewSmsPreview);
byId("newSmsContentInput").addEventListener("keydown", (e) => {
  const ke = e as KeyboardEvent;
  if ((ke.metaKey || ke.ctrlKey) && ke.key === "Enter") {
    ke.preventDefault();
    byId<HTMLFormElement>("newSmsForm").requestSubmit();
  }
});

byId<HTMLFormElement>("newSmsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const countryCode = byId<HTMLSelectElement>("newSmsCountrySelect").value || state.defaultCountryCode;
  const phone = byId<HTMLInputElement>("newSmsPhoneInput").value.trim();
  const content = byId<HTMLTextAreaElement>("newSmsContentInput").value.trim();
  const btn = byId<HTMLButtonElement>("newSmsSubmitBtn");
  const btnHtml = btn.innerHTML;

  btn.disabled = true;
  btn.innerHTML = `<span class="loading loading-spinner loading-xs"></span>发送中`;

  try {
    const res = await apiFetch<SendApiResponse>("/api/send", {
      method: "POST",
      body: JSON.stringify({ phone, countryCode, content }),
    });
    const sentTo = res.data.resolvedPhones?.[0] || phone;
    showToast(`已发送至 ${sentTo}`, "success");
    byId<HTMLInputElement>("newSmsPhoneInput").value = "";
    byId<HTMLTextAreaElement>("newSmsContentInput").value = "";
    byId<HTMLDialogElement>("newSmsModal").close();
    await loadThreads();
    await openThread(sentTo);
  } catch (err) {
    showToast(`发送失败：${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = btnHtml;
  }
});

// =====================================================================
// Contacts & iPhone `.vcf` import
// =====================================================================
async function loadContactsBook(search = ""): Promise<void> {
  const res = await apiFetch<ContactsBookApiResponse>(`/api/contacts/book?search=${encodeURIComponent(search)}`);
  state.contacts = res.data.contacts ?? [];
  const total = res.data.total ?? 0;
  byId("contactsCountBadge").textContent = total ? String(total) : "";
  byId("contactsModalCount").textContent = total ? String(total) : "";
  renderContactsList();
}

function renderContactsList(): void {
  const box = byId("contactsListContainer");
  if (state.contacts.length === 0) {
    box.innerHTML = `
      <div class="flex flex-col items-center gap-2 py-10 text-center anim-fade">
        ${icon("contacts", "text-3xl text-base-content/15")}
        <div class="text-sm text-base-content/50">暂无联系人</div>
        <div class="text-xs text-base-content/40">导入 iPhone 导出的 .vcf，或点击右上角 + 新建</div>
      </div>`;
    return;
  }

  box.innerHTML = state.contacts
    .map(
      (c, i) => `
      <div class="group flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-base-200/70 transition-colors anim-rise" style="--i:${i}">
        ${avatarHtml({ name: c.name, hasContact: true, senderType: "national", size: "size-9 text-xs" })}
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium truncate">${escapeHtml(c.name)}${
            c.note ? `<span class="ml-1.5 font-normal text-base-content/40">${escapeHtml(c.note)}</span>` : ""
          }</div>
          <div class="text-xs font-mono text-base-content/50 truncate">${escapeHtml(c.phones.join(" · "))}</div>
        </div>
        <div class="flex items-center gap-0.5 shrink-0 reveal-on-hover">
          <button type="button" data-compose-to="${escapeHtml(c.phones[0] || "")}" class="btn btn-ghost btn-xs btn-square rounded-lg" title="发信息" aria-label="发信息">${icon(
            "message",
            "text-sm"
          )}</button>
          <button type="button" data-edit-contact="${escapeHtml(c.id)}" class="btn btn-ghost btn-xs btn-square rounded-lg" title="编辑" aria-label="编辑">${icon(
            "pencil",
            "text-sm"
          )}</button>
          <button type="button" data-del-contact="${escapeHtml(c.id)}" class="btn btn-ghost btn-xs btn-square rounded-lg hover:text-error" title="删除" aria-label="删除">${icon(
            "trash",
            "text-sm"
          )}</button>
        </div>
      </div>`
    )
    .join("");
}

byId("contactsListContainer").addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const compose = target.closest<HTMLElement>("[data-compose-to]");
  if (compose) {
    byId<HTMLDialogElement>("contactsModal").close();
    byId<HTMLInputElement>("newSmsPhoneInput").value = compose.getAttribute("data-compose-to") || "";
    openNewSmsModal();
    return;
  }
  const edit = target.closest<HTMLElement>("[data-edit-contact]");
  if (edit) {
    const c = state.contacts.find((x) => x.id === edit.getAttribute("data-edit-contact"));
    if (c) showContactForm({ phone: c.phones[0] || "", name: c.name, note: c.note || "" });
    return;
  }
  const del = target.closest<HTMLElement>("[data-del-contact]");
  if (del) {
    const id = del.getAttribute("data-del-contact") || "";
    const c = state.contacts.find((x) => x.id === id);
    if (!confirm(`删除联系人「${c?.name ?? ""}」？`)) return;
    void (async () => {
      await apiFetch(`/api/contacts/book/${encodeURIComponent(id)}`, { method: "DELETE" });
      await Promise.all([loadContactsBook(), loadThreads()]);
    })();
  }
});

function showContactForm(prefill?: { phone: string; name: string; note: string }): void {
  const form = byId<HTMLFormElement>("manualContactForm");
  form.classList.remove("hidden");
  restartAnimation(form, "anim-pop-in");
  if (prefill) {
    byId<HTMLInputElement>("manualContactPhone").value = prefill.phone;
    byId<HTMLInputElement>("manualContactName").value = prefill.name;
    byId<HTMLInputElement>("manualContactNote").value = prefill.note;
  }
  setTimeout(() => byId<HTMLInputElement>("manualContactName").focus(), 60);
}

function openContactsModal(prefill?: { phone: string; name: string; note: string }): void {
  const form = byId<HTMLFormElement>("manualContactForm");
  if (prefill) {
    showContactForm(prefill);
  } else {
    form.classList.add("hidden");
  }
  byId<HTMLDialogElement>("contactsModal").showModal();
  void loadContactsBook(byId<HTMLInputElement>("contactsSearchInput").value);
}

byId("contactsModalBtn").addEventListener("click", () => {
  navDrawer.checked = false;
  openContactsModal();
});

byId("toggleAddContactBtn").addEventListener("click", () => {
  const form = byId<HTMLFormElement>("manualContactForm");
  if (form.classList.contains("hidden")) {
    form.reset();
    showContactForm();
  } else {
    form.classList.add("hidden");
  }
});

let contactsSearchTimer: ReturnType<typeof setTimeout> | null = null;
byId<HTMLInputElement>("contactsSearchInput").addEventListener("input", (e) => {
  const q = (e.target as HTMLInputElement).value;
  if (contactsSearchTimer) clearTimeout(contactsSearchTimer);
  contactsSearchTimer = setTimeout(() => void loadContactsBook(q), 150);
});

byId<HTMLFormElement>("manualContactForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const phone = byId<HTMLInputElement>("manualContactPhone").value.trim();
  const name = byId<HTMLInputElement>("manualContactName").value.trim();
  const note = byId<HTMLInputElement>("manualContactNote").value.trim();

  try {
    await apiFetch("/api/contacts/book", { method: "POST", body: JSON.stringify({ phone, name, note }) });
    form.reset();
    form.classList.add("hidden");
    showToast(`已保存联系人 ${name}`, "success");
    await Promise.all([loadContactsBook(), loadThreads()]);
    await refreshActiveThread({ preserveScroll: true });
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), "error");
  }
});

byId<HTMLInputElement>("vcfFileInput").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const vcf = await file.text();
    const res = await apiFetch<ImportVcfApiResponse>("/api/contacts/import-vcf", {
      method: "POST",
      body: JSON.stringify({ vcf }),
    });
    const s = res.data;
    showToast(`导入完成：解析 ${s.parsed}，新增 ${s.added}，更新 ${s.updated}（共 ${s.total} 位）`, "success");
    await Promise.all([loadContactsBook(), loadThreads()]);
    await refreshActiveThread({ preserveScroll: true });
  } catch (err) {
    showToast(`导入失败：${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    input.value = "";
  }
});

// =====================================================================
// Keyboard shortcuts
// =====================================================================
document.addEventListener("keydown", (e) => {
  if (!state.authenticated) return;
  const target = e.target as HTMLElement;
  const typing = target.closest("input, textarea, select, [contenteditable='true']") !== null;
  const modalOpen = document.querySelector("dialog[open]") !== null;

  if (e.key === "Escape" && !modalOpen && appView.getAttribute("data-mobile-view") === "chat" && !typing) {
    setMobileChatVisible(false);
    return;
  }
  if (typing || modalOpen || e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === "n" || e.key === "N") {
    e.preventDefault();
    openNewSmsModal();
  } else if (e.key === "/") {
    e.preventDefault();
    setMobileChatVisible(false);
    byId<HTMLInputElement>("searchInput").focus();
  }
});

// =====================================================================
// Bootstrap
// =====================================================================
void (async function init(): Promise<void> {
  try {
    const res = (await fetch("/api/auth/check").then((r) => r.json())) as {
      authenticated?: boolean;
      defaultCountryCode?: string;
    };
    if (res.defaultCountryCode) state.defaultCountryCode = res.defaultCountryCode;
    if (res.authenticated) {
      await enterWorkspace();
    } else {
      showLoginScreen();
    }
  } catch {
    showLoginScreen();
  }
})();
