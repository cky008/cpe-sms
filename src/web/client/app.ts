// Real-time daisyUI Frontend Controller for H168-383 SMS Center (TypeScript)

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

interface AppState {
  authenticated: boolean;
  defaultCountryCode: string;
  countries: CountryOption[];
  threads: UiThread[];
  contacts: ContactEntry[];
  selectedThreadKey: string | null;
  activeThread: UiThreadDetail | null;
  filter: "all" | "unread" | "otp";
  search: string;
  archiveTotal: number;
  cpeStats: CpeStats | null;
  lastFullSyncAt: string | null;
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
  lastFullSyncAt: null,
  sse: null,
};

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// --- Theme Management ---
const savedTheme = localStorage.getItem("cpe_sms_theme") || "light";
document.documentElement.setAttribute("data-theme", savedTheme);
document.querySelectorAll<HTMLButtonElement>("[data-set-theme]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const theme = btn.getAttribute("data-set-theme") || "light";
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("cpe_sms_theme", theme);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
});

// --- Helpers ---
function escapeHtml(str: unknown): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function linkifyHtml(str: string): string {
  const escaped = escapeHtml(str);
  return escaped.replace(
    /(https?:\/\/[^\s<]+)/gi,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="underline font-medium break-all">$1</a>'
  );
}

function formatShortTime(dateStr?: string): string {
  if (!dateStr) return "";
  const [d, t] = dateStr.split(" ");
  if (!d || !t) return dateStr;
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return d === today ? t.slice(0, 5) : `${d.slice(5)} ${t.slice(0, 5)}`;
}

function estimateLocalSmsMode(text: string): {
  encoding: "7BIT" | "UCS2";
  segments: number;
  len: number;
} {
  if (!text) return { encoding: "7BIT", segments: 0, len: 0 };
  const isAscii7 = /^[\x0A\x0D\x20-\x7E€£¥èéùìòÇØøÅå_ÆæßÉÄÖÑÜ§¿äöñüà]*$/.test(text);
  if (!isAscii7) {
    const len = text.length;
    return { encoding: "UCS2", segments: len <= 70 ? 1 : Math.ceil(len / 67), len };
  }
  const len = text.length;
  return { encoding: "7BIT", segments: len <= 160 ? 1 : Math.ceil(len / 153), len };
}

function showToast(message: string, type: "info" | "success" | "error" | "warning" = "info"): void {
  const container = byId("toastContainer");
  const alertClass =
    type === "success"
      ? "alert-success"
      : type === "error"
        ? "alert-error"
        : type === "warning"
          ? "alert-warning"
          : "alert-info";

  const el = document.createElement("div");
  el.className = `alert ${alertClass} shadow-lg text-xs py-2.5 px-4 pointer-events-auto transition-all duration-300`;
  el.innerHTML = `<span>${escapeHtml(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 3600);
}

async function copyText(text: string, label = "已复制"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label}: ${text}`, "success");
  } catch {
    showToast("复制失败，请手动选中复制", "warning");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function apiFetch<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res
    .json()
    .catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (res.status === 401 && path !== "/api/auth/login") {
    showLoginScreen();
    throw new Error("登录会话已过期");
  }
  if (!res.ok || data.ok === false) {
    throw new Error((data.error as string) || `请求失败 (${res.status})`);
  }
  return data as T;
}

// --- Views & Auth ---
const loginView = byId("loginView");
const appView = byId("appView");
const sidebarPane = byId("sidebarPane");
const chatPane = byId("chatPane");
const mobileBackBtn = byId<HTMLButtonElement>("mobileBackBtn");

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
  } finally {
    btn.disabled = false;
  }
});

byId<HTMLButtonElement>("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  showLoginScreen();
});

// --- Real-Time SSE Connection ---
function connectSse(): void {
  if (state.sse) state.sse.close();
  const badge = byId("sseBadge");
  const es = new EventSource("/api/events");
  state.sse = es;

  es.addEventListener("open", () => {
    badge.className = "badge badge-xs badge-success gap-1";
    badge.textContent = "实时在线";
  });

  es.addEventListener("error", () => {
    badge.className = "badge badge-xs badge-warning gap-1";
    badge.textContent = "重连中...";
  });

  es.addEventListener("sms:new", (ev) => {
    void (async () => {
      const msg = JSON.parse((ev as MessageEvent<string>).data) as UiSmsMessage;
      const who = msg.contact?.name || msg.phone;
      const otpTxt = msg.verificationCode ? ` [验证码: ${msg.verificationCode}]` : "";
      showToast(`📩 新短信来自 ${who}${otpTxt}`, "success");

      if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        new Notification(`新短信 · ${who}`, {
          body: msg.verificationCode
            ? `验证码 ${msg.verificationCode} · ${msg.content}`
            : msg.content,
        });
      }

      await loadThreads();
      if (state.selectedThreadKey && state.selectedThreadKey === msg.threadKey) {
        await openThread(state.selectedThreadKey, { preserveScroll: false });
      }
    })();
  });

  es.addEventListener("sms:sent", (ev) => {
    void (async () => {
      const msg = JSON.parse((ev as MessageEvent<string>).data) as UiSmsMessage;
      await loadThreads();
      if (state.selectedThreadKey === msg.threadKey && state.selectedThreadKey) {
        await openThread(state.selectedThreadKey, { preserveScroll: false });
      }
    })();
  });

  es.addEventListener("sms:updated", () => {
    void (async () => {
      await loadThreads();
      if (state.selectedThreadKey) {
        await openThread(state.selectedThreadKey, { preserveScroll: true });
      }
    })();
  });

  es.addEventListener("sms:sync", (ev) => {
    void (async () => {
      const summary = JSON.parse((ev as MessageEvent<string>).data) as {
        archiveTotal: number;
        cpeStats: CpeStats;
      };
      state.archiveTotal = summary.archiveTotal;
      state.cpeStats = summary.cpeStats;
      await loadThreads();
      if (state.selectedThreadKey) {
        await openThread(state.selectedThreadKey, { preserveScroll: true });
      }
    })();
  });

  es.addEventListener("contacts:updated", () => {
    void (async () => {
      await loadContactsBook();
      await loadThreads();
      if (state.selectedThreadKey) {
        await openThread(state.selectedThreadKey, { preserveScroll: true });
      }
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

// --- Device Status & Full Sync ---
async function refreshDeviceStatus(): Promise<void> {
  try {
    const res = await apiFetch("/api/status");
    const d = res.data;
    const op = d.network?.operatorName || d.network?.numericPlmn || "未知运营商";
    const sig5g = d.signal?.nrRsrp ? `5G ${d.signal.nrRsrp}` : "";
    const sig4g = d.signal?.rsrp ? `4G ${d.signal.rsrp}` : "";
    const sigText = [sig5g, sig4g].filter(Boolean).join(" / ") || "信号正常";
    const unread = d.sms?.localUnread ?? 0;
    const inbox = d.sms?.localInbox ?? 0;
    const max = d.sms?.localMax ?? 500;

    byId("signalSubtitle").textContent =
      `${d.device.marketingName || d.device.deviceName} · ${op} · ${sigText} · 未读 ${unread} 条 (${inbox}/${max})`;

    state.cpeStats = {
      localUnread: unread,
      localInbox: inbox,
      localOutbox: d.sms?.localOutbox ?? 0,
      localMax: max,
    };
    state.archiveTotal = d.archiveTotal ?? state.archiveTotal;
    updateFooterStats();
  } catch {
    // Non-fatal on status bar
  }
}

async function triggerFullHistorySync(): Promise<void> {
  const btn = byId<HTMLButtonElement>("syncAllBtn");
  const icon = byId("syncIcon");
  btn.disabled = true;
  icon.classList.add("animate-spin");

  try {
    const res = await apiFetch("/api/archive/sync", { method: "POST" });
    showToast(
      `已同步 CPE 全部 ${res.data.syncedFromCpe} 条短信，本地历史共归档 ${res.data.archiveTotal} 条`,
      "success"
    );
    await Promise.all([loadThreads(), refreshDeviceStatus()]);
    if (state.selectedThreadKey) {
      await openThread(state.selectedThreadKey, { preserveScroll: true });
    }
  } catch (err) {
    showToast(`同步失败: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    btn.disabled = false;
    icon.classList.remove("animate-spin");
  }
}

byId("syncAllBtn").addEventListener("click", () => void triggerFullHistorySync());
byId("emptySyncBtn").addEventListener("click", () => void triggerFullHistorySync());

// --- Thread List Rendering ---
function updateFooterStats(): void {
  byId("archiveFooterText").textContent = `本地加密归档 ${state.archiveTotal} 条`;
  if (state.cpeStats) {
    byId("cpeCapFooterText").textContent =
      `CPE 存储 ${state.cpeStats.localInbox} / ${state.cpeStats.localMax}`;
  }
}

async function loadThreads(): Promise<void> {
  const params = new URLSearchParams({
    filter: state.filter,
    search: state.search,
  });
  const res = await apiFetch(`/api/archive/threads?${params.toString()}`);
  const d = res.data;

  state.threads = (d.threads as UiThread[]) || [];
  state.archiveTotal = d.archiveTotal ?? 0;
  state.cpeStats = d.cpeStats ?? state.cpeStats;
  if (d.defaultCountryCode) state.defaultCountryCode = d.defaultCountryCode;
  if (Array.isArray(d.countries) && d.countries.length > 0 && state.countries.length === 0) {
    state.countries = d.countries as CountryOption[];
    populateCountrySelect();
  }

  byId("contactsCountBadge").textContent = String(d.contactsTotal ?? 0);
  if (state.filter === "all" && !state.search) {
    byId("tabCountAll").textContent = String(state.threads.length);
    const unreadThreads = state.threads.reduce((acc, t) => acc + t.unreadCount, 0);
    byId("tabCountUnread").textContent = String(unreadThreads);
  }
  updateFooterStats();
  renderThreadList();
}

function renderThreadList(): void {
  const container = byId("threadList");
  if (state.threads.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center text-xs text-base-content/50 space-y-2">
        <div class="text-2xl">📭</div>
        <div>没有匹配的短信会话</div>
        <div class="text-[11px]">如果是首次启动，可点击右上角「🔄 同步历史」拉取全部旧短信</div>
      </div>
    `;
    return;
  }

  container.innerHTML = state.threads
    .map((t) => {
      const active = t.threadKey === state.selectedThreadKey;
      const preview = (t.matchedPreview || t.latestMessage?.content || "").replace(/\s+/g, " ");
      const countryTag = t.sender.countryCode
        ? `${t.sender.flag} ${t.sender.countryZh} ${t.sender.countryCode}`
        : `${t.sender.flag} ${t.sender.countryZh}`;
      const subNumber =
        t.contact && t.sender.e164
          ? `<span class="text-[11px] text-base-content/50 font-mono">${escapeHtml(t.sender.e164)}</span>`
          : "";

      return `
        <div
          data-thread-key="${escapeHtml(t.threadKey)}"
          class="thread-item px-3.5 py-3 cursor-pointer transition-colors hover:bg-base-200/70 ${
            active ? "bg-primary/10 border-l-4 border-l-primary" : ""
          }"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-lg shrink-0" title="${escapeHtml(countryTag)}">${t.sender.flag}</span>
              <span class="font-semibold text-sm truncate">${escapeHtml(t.displayName)}</span>
            </div>
            <span class="text-[11px] text-base-content/50 shrink-0">${escapeHtml(
              formatShortTime(t.latestMessage?.date)
            )}</span>
          </div>

          <div class="flex items-center gap-1.5 mt-1 flex-wrap">
            <span class="badge badge-ghost badge-xs">${escapeHtml(countryTag)}</span>
            ${subNumber}
            ${
              t.latestOtp
                ? `<button data-copy-otp="${escapeHtml(
                    t.latestOtp
                  )}" class="badge badge-secondary badge-outline badge-xs cursor-pointer hover:badge-secondary" title="点击复制验证码">🔑 ${escapeHtml(
                    t.latestOtp
                  )}</button>`
                : ""
            }
          </div>

          <div class="flex items-center justify-between gap-2 mt-1.5">
            <p class="text-xs ${
              t.unreadCount > 0 ? "text-base-content font-medium" : "text-base-content/65"
            } truncate">
              ${t.latestMessage?.direction === "out" ? '<span class="opacity-60">我: </span>' : ""}${escapeHtml(
                preview
              )}
            </p>
            ${
              t.unreadCount > 0
                ? `<span class="badge badge-primary badge-xs font-bold shrink-0">${t.unreadCount}</span>`
                : `<span class="text-[10px] text-base-content/40 shrink-0">${t.totalCount}条</span>`
            }
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll<HTMLButtonElement>("[data-copy-otp]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const otp = btn.getAttribute("data-copy-otp") || "";
      void copyText(otp, "验证码已复制");
    });
  });

  container.querySelectorAll<HTMLElement>(".thread-item").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.getAttribute("data-thread-key");
      if (key) void openThread(key);
    });
  });
}

// Search & Filter Tabs
let searchTimer: ReturnType<typeof setTimeout> | null = null;
byId<HTMLInputElement>("searchInput").addEventListener("input", (e) => {
  state.search = (e.target as HTMLInputElement).value;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadThreads(), 180);
});

document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-filter]")
      .forEach((t) => t.classList.remove("tab-active"));
    tab.classList.add("tab-active");
    const f = tab.getAttribute("data-filter");
    state.filter = f === "unread" || f === "otp" ? f : "all";
    void loadThreads();
  });
});

// --- Conversation Detail View ---
function setMobileChatVisible(visible: boolean): void {
  if (visible) {
    sidebarPane.classList.add("hidden", "lg:flex");
    chatPane.classList.remove("hidden");
    chatPane.classList.add("flex");
    mobileBackBtn.classList.remove("hidden");
  } else {
    sidebarPane.classList.remove("hidden");
    chatPane.classList.add("hidden");
    chatPane.classList.remove("flex");
    mobileBackBtn.classList.add("hidden");
  }
}

mobileBackBtn.addEventListener("click", () => {
  setMobileChatVisible(false);
});

async function openThread(
  threadKey: string,
  opts: { preserveScroll: boolean } = { preserveScroll: false }
): Promise<void> {
  state.selectedThreadKey = threadKey;
  renderThreadList();
  setMobileChatVisible(true);

  const res = await apiFetch(`/api/archive/thread?key=${encodeURIComponent(threadKey)}`);
  const detail = res.data as UiThreadDetail;
  state.activeThread = detail;

  byId("emptyChatState").classList.add("hidden");
  byId("activeChatContainer").classList.remove("hidden");

  const s = detail.sender;
  byId("chatHeaderFlag").textContent = s.flag || "📱";
  const title = detail.contact
    ? detail.contact.name
    : s.brandHint && s.type !== "alphanumeric"
      ? `${s.e164 || detail.phone} (${s.brandHint})`
      : s.e164 || detail.phone;
  byId("chatHeaderTitle").textContent = title;
  byId("chatHeaderCountryBadge").textContent = s.countryCode
    ? `${s.countryZh} ${s.countryCode}`
    : s.countryZh;
  byId("chatHeaderSub").textContent = detail.contact
    ? `号码: ${s.e164 || detail.phone}${detail.contact.note ? ` · ${detail.contact.note}` : ""} · 共 ${detail.messages.length} 条记录`
    : `原始号码: ${detail.phone} · 共 ${detail.messages.length} 条记录`;

  const unreadIndices = detail.messages
    .filter((m) => m.isUnread && m.onCpe && m.index > 0)
    .map((m) => m.index);
  const markBtn = byId<HTMLButtonElement>("markThreadReadBtn");
  if (unreadIndices.length > 0) {
    markBtn.classList.remove("hidden");
    markBtn.textContent = `✅ 标为已读 (${unreadIndices.length})`;
    markBtn.onclick = async () => {
      markBtn.disabled = true;
      try {
        await apiFetch("/api/read", {
          method: "POST",
          body: JSON.stringify({ indices: unreadIndices }),
        });
        showToast(`已将 ${unreadIndices.length} 条短信标为已读`, "success");
        await Promise.all([loadThreads(), openThread(threadKey, { preserveScroll: true })]);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      } finally {
        markBtn.disabled = false;
      }
    };
  } else {
    markBtn.classList.add("hidden");
  }

  const replyForm = byId("replyForm");
  const banner = byId("nonDialableBanner");
  if (detail.dialable && detail.replyPhone) {
    banner.classList.add("hidden");
    replyForm.classList.remove("hidden");
    byId("replyTargetHint").textContent = `回复至: ${s.flag} ${detail.replyPhone} (${s.countryZh})`;
  } else {
    replyForm.classList.add("hidden");
    banner.classList.remove("hidden");
  }

  const listEl = byId("messagesList");
  const prevScroll = listEl.scrollTop;

  listEl.innerHTML = detail.messages
    .map((m) => {
      const isOut = m.direction === "out";
      const align = isOut ? "chat-end" : "chat-start";
      const bubbleColor = isOut
        ? "chat-bubble-primary"
        : "bg-base-100 text-base-content border border-base-300 shadow-xs";
      const senderLabel = isOut ? "我" : detail.contact?.name || m.phone;
      const statusBadge =
        !m.onCpe && m.index > 0
          ? `<span class="badge badge-ghost badge-xs">仅本地归档</span>`
          : m.isUnread
            ? `<span class="badge badge-primary badge-xs">未读</span>`
            : "";

      return `
        <div class="chat ${align} group">
          <div class="chat-header text-[11px] text-base-content/55 flex items-center gap-1.5 mb-0.5">
            <span class="font-medium">${escapeHtml(senderLabel)}</span>
            <time>${escapeHtml(m.date)}</time>
            ${m.index > 0 ? `<span class="opacity-60">#${m.index}</span>` : ""}
            ${statusBadge}
          </div>

          <div class="chat-bubble ${bubbleColor} text-sm whitespace-pre-wrap break-words max-w-[85%] sm:max-w-[75%]">${linkifyHtml(
            m.content
          )}</div>

          <div class="chat-footer mt-1 flex items-center gap-2">
            ${
              m.verificationCode
                ? `<button data-msg-otp="${escapeHtml(
                    m.verificationCode
                  )}" class="btn btn-xs btn-secondary btn-outline gap-1">🔑 复制验证码 ${escapeHtml(
                    m.verificationCode
                  )}</button>`
                : ""
            }
            <button
              data-del-uid="${escapeHtml(m.uid)}"
              data-del-index="${m.onCpe ? m.index : 0}"
              class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100 text-error/70 hover:text-error transition-opacity"
              title="删除此条短信"
            >
              🗑 删除
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  listEl.querySelectorAll<HTMLButtonElement>("[data-msg-otp]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const otp = btn.getAttribute("data-msg-otp") || "";
      void copyText(otp, "验证码已复制");
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>("[data-del-uid]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.getAttribute("data-del-uid") || "";
      const idx = Number(btn.getAttribute("data-del-index"));
      const msg =
        idx > 0
          ? "确定从 CPE 路由器和本地历史中删除这条短信吗？"
          : "确定从本地归档记录中删除这条短信吗？";
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
        showToast("已删除短信", "success");
        await Promise.all([loadThreads(), openThread(threadKey, { preserveScroll: true })]);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      }
    });
  });

  if (opts.preserveScroll) {
    listEl.scrollTop = prevScroll;
  } else {
    listEl.scrollTop = listEl.scrollHeight;
  }
}

// Edit Contact Nickname from Active Chat Header
byId("editNicknameBtn").addEventListener("click", () => {
  if (!state.activeThread) return;
  const currentPhone = state.activeThread.sender.e164 || state.activeThread.phone;
  const currentName = state.activeThread.contact?.name || "";
  const modal = byId<HTMLDialogElement>("contactsModal");
  byId<HTMLInputElement>("manualContactPhone").value = currentPhone;
  byId<HTMLInputElement>("manualContactName").value = currentName;
  byId<HTMLInputElement>("manualContactNote").value = state.activeThread.contact?.note || "";
  modal.showModal();
  setTimeout(() => byId<HTMLInputElement>("manualContactName").focus(), 50);
});

// Reply Composer Submit
const replyTextarea = byId<HTMLTextAreaElement>("replyTextarea");
replyTextarea.addEventListener("input", () => {
  const info = estimateLocalSmsMode(replyTextarea.value);
  byId("replyEncodingHint").textContent =
    `${info.encoding} · ${info.len} 字 · 预计 ${info.segments} 条`;
});

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

  const btn = byId<HTMLButtonElement>("replySendBtn");
  btn.disabled = true;
  btn.textContent = "发送中...";

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
    byId("replyEncodingHint").textContent = "GSM 7-bit · 0 字";
    showToast(`✅ 短信已成功发送至 ${state.activeThread.replyPhone}`, "success");
    if (state.selectedThreadKey) {
      await Promise.all([
        loadThreads(),
        openThread(state.selectedThreadKey, { preserveScroll: false }),
      ]);
    }
  } catch (err) {
    showToast(`发送失败: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "发送";
  }
});

// --- Guided New SMS Modal ---
function populateCountrySelect(): void {
  const sel = byId<HTMLSelectElement>("newSmsCountrySelect");
  sel.innerHTML = state.countries
    .map(
      (c) =>
        `<option value="${escapeHtml(c.code)}" ${
          c.code === state.defaultCountryCode ? "selected" : ""
        }>${c.flag} ${escapeHtml(c.nameZh)} (${escapeHtml(c.code)})</option>`
    )
    .join("");
}

function openNewSmsModal(): void {
  const modal = byId<HTMLDialogElement>("newSmsModal");
  modal.showModal();
  updateNewSmsPreview();
  setTimeout(() => byId<HTMLInputElement>("newSmsPhoneInput").focus(), 50);
}

byId("newSmsBtn").addEventListener("click", openNewSmsModal);
byId("emptyNewSmsBtn").addEventListener("click", openNewSmsModal);

let previewTimer: ReturnType<typeof setTimeout> | null = null;
function updateNewSmsPreview(): void {
  const countryCode =
    byId<HTMLSelectElement>("newSmsCountrySelect").value || state.defaultCountryCode;
  const rawPhone = byId<HTMLInputElement>("newSmsPhoneInput").value.trim();
  const content = byId<HTMLTextAreaElement>("newSmsContentInput").value;
  const sugBox = byId("newSmsContactSuggestions");
  const prevBox = byId("newSmsResolvedPreview");

  const mode = estimateLocalSmsMode(content);
  byId("newSmsModeHint").textContent =
    `${mode.encoding} · ${mode.len} 字 · 预计 ${mode.segments || 1} 条`;

  if (rawPhone) {
    const q = rawPhone.toLowerCase();
    const hits = state.contacts
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.phones.some((p) => p.toLowerCase().includes(q))
      )
      .slice(0, 5);

    if (hits.length > 0) {
      sugBox.classList.remove("hidden");
      sugBox.innerHTML = hits
        .map((c) =>
          c.phones
            .slice(0, 2)
            .map(
              (ph) =>
                `<button type="button" data-pick-phone="${escapeHtml(
                  ph
                )}" class="btn btn-xs btn-soft btn-primary">👤 ${escapeHtml(
                  c.name
                )} (${escapeHtml(ph)})</button>`
            )
            .join("")
        )
        .join("");
      sugBox.querySelectorAll<HTMLButtonElement>("[data-pick-phone]").forEach((b) => {
        b.addEventListener("click", () => {
          byId<HTMLInputElement>("newSmsPhoneInput").value =
            b.getAttribute("data-pick-phone") || "";
          sugBox.classList.add("hidden");
          updateNewSmsPreview();
          byId<HTMLTextAreaElement>("newSmsContentInput").focus();
        });
      });
    } else {
      sugBox.classList.add("hidden");
    }
  } else {
    sugBox.classList.add("hidden");
    prevBox.textContent = `当前默认区号 ${countryCode}：可直接输入爱尔兰本地号 (如 0831234567) 或带 + 国际号码`;
    return;
  }

  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    void (async () => {
      try {
        const res = await apiFetch("/api/sms/preview", {
          method: "POST",
          body: JSON.stringify({ phone: rawPhone, countryCode, content }),
        });
        const r = res.data.recipient;
        if (r?.ok) {
          prevBox.innerHTML = `✅ 将发送至：<b>${r.flag} ${escapeHtml(r.countryZh)}</b> · <code class="font-mono font-bold">${escapeHtml(
            r.phone
          )}</code>`;
        } else {
          prevBox.innerHTML = `<span class="text-warning">⚠️ ${escapeHtml(
            r?.error || "请输入有效号码或点击上方匹配的联系人"
          )}</span>`;
        }
      } catch {
        // ignore transient preview errors
      }
    })();
  }, 150);
}

byId("newSmsCountrySelect").addEventListener("change", updateNewSmsPreview);
byId("newSmsPhoneInput").addEventListener("input", updateNewSmsPreview);
byId("newSmsContentInput").addEventListener("input", updateNewSmsPreview);

byId<HTMLFormElement>("newSmsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const countryCode =
    byId<HTMLSelectElement>("newSmsCountrySelect").value || state.defaultCountryCode;
  const phone = byId<HTMLInputElement>("newSmsPhoneInput").value.trim();
  const content = byId<HTMLTextAreaElement>("newSmsContentInput").value.trim();
  const btn = byId<HTMLButtonElement>("newSmsSubmitBtn");

  btn.disabled = true;
  btn.textContent = "正在通过 CPE 发送...";

  try {
    const res = await apiFetch("/api/send", {
      method: "POST",
      body: JSON.stringify({ phone, countryCode, content }),
    });
    const sentTo = (res.data.resolvedPhones?.[0] as string) || phone;
    showToast(`✅ 短信已成功发送至 ${sentTo}`, "success");
    byId<HTMLInputElement>("newSmsPhoneInput").value = "";
    byId<HTMLTextAreaElement>("newSmsContentInput").value = "";
    byId<HTMLDialogElement>("newSmsModal").close();
    await loadThreads();
    await openThread(sentTo);
  } catch (err) {
    showToast(`发送失败: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🚀 立即发送";
  }
});

// --- Contacts Book & iPhone `.vcf` Import ---
async function loadContactsBook(search = ""): Promise<void> {
  const res = await apiFetch(`/api/contacts/book?search=${encodeURIComponent(search)}`);
  state.contacts = (res.data.contacts as ContactEntry[]) || [];
  byId("contactsCountBadge").textContent = String(res.data.total ?? 0);
  renderContactsList();
}

function renderContactsList(): void {
  const box = byId("contactsListContainer");
  if (state.contacts.length === 0) {
    box.innerHTML = `<div class="p-6 text-center text-xs text-base-content/50">暂无联系人，可导入 iPhone .vcf 文件或在上方手动添加</div>`;
    return;
  }

  box.innerHTML = state.contacts
    .map(
      (c) => `
      <div class="px-3 py-2 flex items-center justify-between gap-2 text-xs hover:bg-base-200/50">
        <div class="min-w-0">
          <div class="font-semibold truncate">
            👤 ${escapeHtml(c.name)}
            ${c.note ? `<span class="text-base-content/50 font-normal">(${escapeHtml(c.note)})</span>` : ""}
          </div>
          <div class="font-mono text-base-content/60 truncate">${escapeHtml(c.phones.join(" · "))}</div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button data-compose-to="${escapeHtml(c.phones[0] || "")}" class="btn btn-xs btn-ghost text-primary">
            发短信
          </button>
          <button data-del-contact="${escapeHtml(c.id)}" class="btn btn-xs btn-ghost text-error/70">
            删除
          </button>
        </div>
      </div>
    `
    )
    .join("");

  box.querySelectorAll<HTMLButtonElement>("[data-compose-to]").forEach((btn) => {
    btn.addEventListener("click", () => {
      byId<HTMLDialogElement>("contactsModal").close();
      byId<HTMLInputElement>("newSmsPhoneInput").value = btn.getAttribute("data-compose-to") || "";
      openNewSmsModal();
    });
  });

  box.querySelectorAll<HTMLButtonElement>("[data-del-contact]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del-contact") || "";
      await apiFetch(`/api/contacts/book/${encodeURIComponent(id)}`, { method: "DELETE" });
      await Promise.all([loadContactsBook(), loadThreads()]);
    });
  });
}

byId("contactsModalBtn").addEventListener("click", async () => {
  await loadContactsBook();
  byId<HTMLDialogElement>("contactsModal").showModal();
});

byId<HTMLInputElement>("contactsSearchInput").addEventListener("input", (e) => {
  void loadContactsBook((e.target as HTMLInputElement).value);
});

byId<HTMLFormElement>("manualContactForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const phoneInput = byId<HTMLInputElement>("manualContactPhone");
  const nameInput = byId<HTMLInputElement>("manualContactName");
  const noteInput = byId<HTMLInputElement>("manualContactNote");
  const phone = phoneInput.value.trim();
  const name = nameInput.value.trim();
  const note = noteInput.value.trim();

  try {
    await apiFetch("/api/contacts/book", {
      method: "POST",
      body: JSON.stringify({ phone, name, note }),
    });
    phoneInput.value = "";
    nameInput.value = "";
    noteInput.value = "";
    showToast(`已保存联系人: ${name}`, "success");
    await Promise.all([loadContactsBook(), loadThreads()]);
    if (state.selectedThreadKey) {
      await openThread(state.selectedThreadKey, { preserveScroll: true });
    }
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
    const res = await apiFetch("/api/contacts/import-vcf", {
      method: "POST",
      body: JSON.stringify({ vcf }),
    });
    const s = res.data;
    showToast(
      `📇 导入完成！解析 ${s.parsed} 条，新增 ${s.added} 位，更新 ${s.updated} 位（共 ${s.total} 位）`,
      "success"
    );
    await Promise.all([loadContactsBook(), loadThreads()]);
    if (state.selectedThreadKey) {
      await openThread(state.selectedThreadKey, { preserveScroll: true });
    }
  } catch (err) {
    showToast(`导入失败: ${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    input.value = "";
  }
});

// --- Initial Bootstrap ---
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

export {};
