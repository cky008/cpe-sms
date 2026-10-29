// Pure formatting, grouping, signal, and palette helpers for the Sujian (素笺) Web UI
export const BASE_THEMES = [
    { id: "sujian-light", label: "晴昼", nativePrimary: "oklch(60.5% 0.2 257)" },
    { id: "sujian-dark", label: "墨夜", nativePrimary: "oklch(67% 0.17 255)" },
    { id: "sujian-paper", label: "宣纸", nativePrimary: "oklch(60% 0.15 42)" },
    { id: "sujian-midnight", label: "深黛", nativePrimary: "oklch(72% 0.13 222)" },
];
export const ACCENT_PALETTE = [
    { id: "default", label: "随主题", color: "" },
    { id: "blue", label: "经典蓝", color: "oklch(60.5% 0.2 257)" },
    { id: "indigo", label: "靛青", color: "oklch(57% 0.21 277)" },
    { id: "purple", label: "鸢尾紫", color: "oklch(60% 0.2 305)" },
    { id: "pink", label: "玫瑰粉", color: "oklch(63% 0.2 355)" },
    { id: "red", label: "朱砂红", color: "oklch(60% 0.21 25)" },
    { id: "orange", label: "琥珀橙", color: "oklch(67% 0.18 50)" },
    { id: "green", label: "松石绿", color: "oklch(62% 0.15 155)" },
    { id: "teal", label: "海湾青", color: "oklch(62% 0.12 200)" },
    { id: "graphite", label: "石墨灰", color: "oklch(52% 0.01 270)" },
];
export function isThemeId(value) {
    return BASE_THEMES.some((t) => t.id === value);
}
export function isAccentId(value) {
    return ACCENT_PALETTE.some((a) => a.id === value);
}
export function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
export function linkifyHtml(str) {
    const escaped = escapeHtml(str);
    return escaped.replace(/(https?:\/\/[^\s<]+)/gi, '<a href="$1" target="_blank" rel="noopener noreferrer" class="break-all">$1</a>');
}
const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_EN = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];
/** Whole-day difference between `refNow` and a `YYYY-MM-DD` string (0 = today). */
export function daysAgo(datePart, refNow = new Date()) {
    const parts = datePart.split("-").map(Number);
    const y = parts[0];
    const m = parts[1];
    const d = parts[2];
    if (!y || !m || !d)
        return Number.POSITIVE_INFINITY;
    const then = new Date(y, m - 1, d).getTime();
    const today = new Date(refNow.getFullYear(), refNow.getMonth(), refNow.getDate()).getTime();
    return Math.round((today - then) / 86_400_000);
}
export function formatShortTime(dateStr, refNow = new Date(), lang = "zh-CN") {
    if (!dateStr)
        return "";
    const [d, t] = dateStr.split(" ");
    if (!d || !t)
        return dateStr;
    const isEn = lang.toLowerCase().startsWith("en");
    const diff = daysAgo(d, refNow);
    if (diff === 0)
        return t.slice(0, 5);
    if (diff === 1)
        return isEn ? "Yesterday" : "昨天";
    if (diff > 1 && diff < 7) {
        const [y, m, day] = d.split("-").map(Number);
        const dayIdx = new Date(y, m - 1, day).getDay();
        return isEn ? (WEEKDAYS_EN[dayIdx] ?? d) : (WEEKDAYS_ZH[dayIdx] ?? d);
    }
    const [y, m, day] = d.split("-");
    if (isEn) {
        const monthName = MONTHS_EN[Number(m) - 1] ?? m;
        return y === String(refNow.getFullYear())
            ? `${monthName} ${Number(day)}`
            : `${monthName} ${Number(day)}, ${y}`;
    }
    return y === String(refNow.getFullYear())
        ? `${Number(m)}月${Number(day)}日`
        : `${y}/${Number(m)}/${Number(day)}`;
}
export function formatDayLabel(datePart, refNow = new Date(), lang = "zh-CN") {
    const isEn = lang.toLowerCase().startsWith("en");
    const diff = daysAgo(datePart, refNow);
    if (diff === 0)
        return isEn ? "Today" : "今天";
    if (diff === 1)
        return isEn ? "Yesterday" : "昨天";
    const [y, m, d] = datePart.split("-");
    const dayIdx = new Date(Number(y), Number(m) - 1, Number(d)).getDay();
    if (isEn) {
        const monthName = MONTHS_EN[Number(m) - 1] ?? m;
        const weekday = WEEKDAYS_EN[dayIdx] ?? "";
        if (y === String(refNow.getFullYear()))
            return `${monthName} ${Number(d)}, ${weekday}`;
        return `${monthName} ${Number(d)}, ${y}`;
    }
    const weekday = WEEKDAYS_ZH[dayIdx] ?? "";
    if (y === String(refNow.getFullYear()))
        return `${Number(m)}月${Number(d)}日 ${weekday}`;
    return `${y}年${Number(m)}月${Number(d)}日`;
}
export function threadGroupLabel(dateStr, refNow = new Date(), lang = "zh-CN") {
    const isEn = lang.toLowerCase().startsWith("en");
    const diff = daysAgo((dateStr ?? "").split(" ")[0] ?? "", refNow);
    if (diff <= 0)
        return isEn ? "Today" : "今天";
    if (diff === 1)
        return isEn ? "Yesterday" : "昨天";
    if (diff < 7)
        return isEn ? "This Week" : "本周";
    if (diff < 31)
        return isEn ? "This Month" : "本月";
    return isEn ? "Earlier" : "更早";
}
export function parseMsgTime(dateStr) {
    const [d, t] = dateStr.split(" ");
    if (!d)
        return 0;
    const [y, m, day] = d.split("-").map(Number);
    const [hh = 0, mm = 0, ss = 0] = (t ?? "").split(":").map(Number);
    if (!y || !m || !day)
        return 0;
    return new Date(y, m - 1, day, hh, mm, ss).getTime();
}
export function initialsOf(name) {
    const clean = name.trim().replace(/^[^\p{L}\p{N}]+/u, "");
    if (!clean)
        return "?";
    const first = clean[0] ?? "?";
    if (/[\u3400-\u9fff]/.test(first))
        return first;
    const words = clean.split(/[\s_-]+/).filter(Boolean);
    const letters = words.length > 1 &&
        words[0]?.[0] &&
        words[1]?.[0] &&
        /\p{L}/u.test(words[0][0]) &&
        /\p{L}/u.test(words[1][0])
        ? `${words[0][0]}${words[1][0]}`
        : clean.replace(/\s+/g, "").slice(0, 2);
    return letters.toUpperCase();
}
export function signalLevel(raw) {
    const n = Number.parseFloat(String(raw ?? "").replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(n) || n === 0)
        return 0;
    if (n >= -80)
        return 4;
    if (n >= -90)
        return 3;
    if (n >= -100)
        return 2;
    if (n >= -110)
        return 1;
    return 0;
}
export function estimateLocalSmsMode(text) {
    if (!text)
        return { encoding: "7BIT", segments: 0, len: 0 };
    const isAscii7 = /^[\x0A\x0D\x20-\x7E€£¥èéùìòÇØøÅå_ÆæßÉÄÖÑÜ§¿äöñüà]*$/.test(text);
    const len = text.length;
    if (!isAscii7) {
        return { encoding: "UCS2", segments: len <= 70 ? 1 : Math.ceil(len / 67), len };
    }
    return { encoding: "7BIT", segments: len <= 160 ? 1 : Math.ceil(len / 153), len };
}
export function describeSmsMode(text, lang = "zh-CN") {
    const isEn = lang.toLowerCase().startsWith("en");
    const info = estimateLocalSmsMode(text);
    const enc = info.encoding === "7BIT" ? "GSM-7" : "UCS-2";
    if (isEn) {
        return info.len === 0
            ? `${enc} · 0 chars`
            : `${enc} · ${info.len} char${info.len > 1 ? "s" : ""} · ${info.segments} segment${info.segments > 1 ? "s" : ""}`;
    }
    return info.len === 0 ? `${enc} · 0 字` : `${enc} · ${info.len} 字 · ${info.segments} 条`;
}
/**
 * Returns true when user input in the recipient field looks like a contact name search
 * (letters/CJK without dialable digits) rather than a phone number.
 */
export function isLikelyContactNameQuery(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return false;
    return /\p{L}/u.test(trimmed) && !/\d{3,}/.test(trimmed);
}
