import type { CountryDialInfo, ResolvedRecipient, SenderInfo } from "./types.ts";

/**
 * International calling code table with flag emoji, Chinese/English names,
 * and national trunk `'0'` stripping rules for E.164 formatting.
 */
export const COUNTRY_DIAL_CODES: readonly CountryDialInfo[] = [
  { code: "+353", iso: "IE", flag: "🇮🇪", nameZh: "爱尔兰", nameEn: "Ireland", dropTrunkZero: true },
  { code: "+86", iso: "CN", flag: "🇨🇳", nameZh: "中国大陆", nameEn: "China", dropTrunkZero: false },
  { code: "+44", iso: "GB", flag: "🇬🇧", nameZh: "英国", nameEn: "United Kingdom", dropTrunkZero: true },
  { code: "+852", iso: "HK", flag: "🇭🇰", nameZh: "中国香港", nameEn: "Hong Kong", dropTrunkZero: false },
  { code: "+853", iso: "MO", flag: "🇲🇴", nameZh: "中国澳门", nameEn: "Macau", dropTrunkZero: false },
  { code: "+886", iso: "TW", flag: "🇹🇼", nameZh: "中国台湾", nameEn: "Taiwan", dropTrunkZero: true },
  { code: "+1", iso: "US", flag: "🇺🇸", nameZh: "美国/加拿大", nameEn: "US / Canada", dropTrunkZero: false },
  { code: "+49", iso: "DE", flag: "🇩🇪", nameZh: "德国", nameEn: "Germany", dropTrunkZero: true },
  { code: "+33", iso: "FR", flag: "🇫🇷", nameZh: "法国", nameEn: "France", dropTrunkZero: true },
  { code: "+34", iso: "ES", flag: "🇪🇸", nameZh: "西班牙", nameEn: "Spain", dropTrunkZero: false },
  { code: "+39", iso: "IT", flag: "🇮🇹", nameZh: "意大利", nameEn: "Italy", dropTrunkZero: false },
  { code: "+31", iso: "NL", flag: "🇳🇱", nameZh: "荷兰", nameEn: "Netherlands", dropTrunkZero: true },
  { code: "+32", iso: "BE", flag: "🇧🇪", nameZh: "比利时", nameEn: "Belgium", dropTrunkZero: true },
  { code: "+41", iso: "CH", flag: "🇨🇭", nameZh: "瑞士", nameEn: "Switzerland", dropTrunkZero: true },
  { code: "+43", iso: "AT", flag: "🇦🇹", nameZh: "奥地利", nameEn: "Austria", dropTrunkZero: true },
  { code: "+351", iso: "PT", flag: "🇵🇹", nameZh: "葡萄牙", nameEn: "Portugal", dropTrunkZero: false },
  { code: "+352", iso: "LU", flag: "🇱🇺", nameZh: "卢森堡", nameEn: "Luxembourg", dropTrunkZero: false },
  { code: "+358", iso: "FI", flag: "🇫🇮", nameZh: "芬兰", nameEn: "Finland", dropTrunkZero: true },
  { code: "+45", iso: "DK", flag: "🇩🇰", nameZh: "丹麦", nameEn: "Denmark", dropTrunkZero: false },
  { code: "+46", iso: "SE", flag: "🇸🇪", nameZh: "瑞典", nameEn: "Sweden", dropTrunkZero: true },
  { code: "+47", iso: "NO", flag: "🇳🇴", nameZh: "挪威", nameEn: "Norway", dropTrunkZero: false },
  { code: "+48", iso: "PL", flag: "🇵🇱", nameZh: "波兰", nameEn: "Poland", dropTrunkZero: false },
  { code: "+420", iso: "CZ", flag: "🇨🇿", nameZh: "捷克", nameEn: "Czechia", dropTrunkZero: false },
  { code: "+30", iso: "GR", flag: "🇬🇷", nameZh: "希腊", nameEn: "Greece", dropTrunkZero: false },
  { code: "+36", iso: "HU", flag: "🇭🇺", nameZh: "匈牙利", nameEn: "Hungary", dropTrunkZero: true },
  { code: "+40", iso: "RO", flag: "🇷🇴", nameZh: "罗马尼亚", nameEn: "Romania", dropTrunkZero: true },
  { code: "+380", iso: "UA", flag: "🇺🇦", nameZh: "乌克兰", nameEn: "Ukraine", dropTrunkZero: true },
  { code: "+7", iso: "RU", flag: "🇷🇺", nameZh: "俄罗斯/哈萨克", nameEn: "Russia / KZ", dropTrunkZero: true },
  { code: "+90", iso: "TR", flag: "🇹🇷", nameZh: "土耳其", nameEn: "Turkey", dropTrunkZero: true },
  { code: "+971", iso: "AE", flag: "🇦🇪", nameZh: "阿联酋", nameEn: "UAE", dropTrunkZero: true },
  { code: "+972", iso: "IL", flag: "🇮🇱", nameZh: "以色列", nameEn: "Israel", dropTrunkZero: true },
  { code: "+966", iso: "SA", flag: "🇸🇦", nameZh: "沙特", nameEn: "Saudi Arabia", dropTrunkZero: true },
  { code: "+81", iso: "JP", flag: "🇯🇵", nameZh: "日本", nameEn: "Japan", dropTrunkZero: true },
  { code: "+82", iso: "KR", flag: "🇰🇷", nameZh: "韩国", nameEn: "South Korea", dropTrunkZero: true },
  { code: "+65", iso: "SG", flag: "🇸🇬", nameZh: "新加坡", nameEn: "Singapore", dropTrunkZero: false },
  { code: "+60", iso: "MY", flag: "🇲🇾", nameZh: "马来西亚", nameEn: "Malaysia", dropTrunkZero: true },
  { code: "+66", iso: "TH", flag: "🇹🇭", nameZh: "泰国", nameEn: "Thailand", dropTrunkZero: true },
  { code: "+84", iso: "VN", flag: "🇻🇳", nameZh: "越南", nameEn: "Vietnam", dropTrunkZero: true },
  { code: "+62", iso: "ID", flag: "🇮🇩", nameZh: "印尼", nameEn: "Indonesia", dropTrunkZero: true },
  { code: "+63", iso: "PH", flag: "🇵🇭", nameZh: "菲律宾", nameEn: "Philippines", dropTrunkZero: true },
  { code: "+91", iso: "IN", flag: "🇮🇳", nameZh: "印度", nameEn: "India", dropTrunkZero: true },
  { code: "+61", iso: "AU", flag: "🇦🇺", nameZh: "澳大利亚", nameEn: "Australia", dropTrunkZero: true },
  { code: "+64", iso: "NZ", flag: "🇳🇿", nameZh: "新西兰", nameEn: "New Zealand", dropTrunkZero: true },
  { code: "+55", iso: "BR", flag: "🇧🇷", nameZh: "巴西", nameEn: "Brazil", dropTrunkZero: true },
  { code: "+52", iso: "MX", flag: "🇲🇽", nameZh: "墨西哥", nameEn: "Mexico", dropTrunkZero: false },
  { code: "+54", iso: "AR", flag: "🇦🇷", nameZh: "阿根廷", nameEn: "Argentina", dropTrunkZero: true },
  { code: "+27", iso: "ZA", flag: "🇿🇦", nameZh: "南非", nameEn: "South Africa", dropTrunkZero: true },
  { code: "+20", iso: "EG", flag: "🇪🇬", nameZh: "埃及", nameEn: "Egypt", dropTrunkZero: true },
  { code: "+234", iso: "NG", flag: "🇳🇬", nameZh: "尼日利亚", nameEn: "Nigeria", dropTrunkZero: true },
  { code: "+356", iso: "MT", flag: "🇲🇹", nameZh: "马耳他", nameEn: "Malta", dropTrunkZero: false },
  { code: "+357", iso: "CY", flag: "🇨🇾", nameZh: "塞浦路斯", nameEn: "Cyprus", dropTrunkZero: false },
  { code: "+370", iso: "LT", flag: "🇱🇹", nameZh: "立陶宛", nameEn: "Lithuania", dropTrunkZero: true },
  { code: "+371", iso: "LV", flag: "🇱🇻", nameZh: "拉脱维亚", nameEn: "Latvia", dropTrunkZero: false },
  { code: "+372", iso: "EE", flag: "🇪🇪", nameZh: "爱沙尼亚", nameEn: "Estonia", dropTrunkZero: false },
];

const SORTED_BY_CODE_LEN = [...COUNTRY_DIAL_CODES].sort(
  (a, b) => b.code.length - a.code.length
);

const BY_CODE_MAP = new Map<string, CountryDialInfo>(
  COUNTRY_DIAL_CODES.map((c) => [c.code, c])
);

export function getCountryByDialCode(dialCode: string): CountryDialInfo | null {
  const normalized = dialCode.startsWith("+") ? dialCode : `+${dialCode}`;
  return BY_CODE_MAP.get(normalized) ?? null;
}

export function matchCountryFromE164(e164: string): CountryDialInfo | null {
  if (!e164 || !e164.startsWith("+")) return null;
  for (const entry of SORTED_BY_CODE_LEN) {
    if (e164.startsWith(entry.code) && e164.length > entry.code.length) {
      return entry;
    }
  }
  return null;
}

export function extractBrandSignature(content: string): string | null {
  if (!content) return null;
  const trimmed = content.trim();
  const leadingBracket = trimmed.match(/^(?:【([^】]{1,20})】|\[([^\]]{2,20})\])/);
  if (leadingBracket) {
    return (leadingBracket[1] ?? leadingBracket[2] ?? "").trim() || null;
  }
  const trailingBracket = trimmed.match(/(?:【([^】]{1,20})】)\s*$/);
  if (trailingBracket?.[1]) {
    return trailingBracket[1].trim();
  }
  const colonPrefix = trimmed.match(/^([A-Z][A-Za-z0-9 .&-]{1,18}):\s+/);
  if (colonPrefix?.[1]) {
    return colonPrefix[1].trim();
  }
  return null;
}

export function cleanPhoneFormatting(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/[\s\-().\u00A0\u200B-\u200D\u202A-\u202E]/g, "");
}

export function parseSenderInfo(
  rawPhone: string,
  smsContent = "",
  defaultCountryCode = "+353"
): SenderInfo {
  const raw = String(rawPhone ?? "").trim();
  const brandHint = extractBrandSignature(smsContent);

  if (!raw) {
    return {
      type: "unknown",
      raw: "",
      e164: null,
      dialable: false,
      flag: "❓",
      countryCode: null,
      countryZh: "未知来源",
      countryIso: null,
      brandHint,
      displayNumber: "未知号码",
    };
  }

  if (/[A-Za-z\u4e00-\u9fa5]/.test(raw)) {
    return {
      type: "alphanumeric",
      raw,
      e164: null,
      dialable: false,
      flag: "🏢",
      countryCode: null,
      countryZh: "品牌/机构服务号",
      countryIso: null,
      brandHint: brandHint ?? raw,
      displayNumber: raw,
    };
  }

  const cleaned = cleanPhoneFormatting(raw);

  if (/^106\d{5,17}$/.test(cleaned)) {
    return {
      type: "gateway",
      raw,
      e164: cleaned,
      dialable: true,
      flag: "🇨🇳",
      countryCode: "+86",
      countryZh: "中国服务通道 (106)",
      countryIso: "CN",
      brandHint,
      displayNumber: cleaned,
    };
  }

  if (/^\d{1,6}$/.test(cleaned)) {
    return {
      type: "shortcode",
      raw,
      e164: cleaned,
      dialable: true,
      flag: "📟",
      countryCode: null,
      countryZh: "运营商/服务短号",
      countryIso: null,
      brandHint,
      displayNumber: cleaned,
    };
  }

  if (/^(?:861[3-9]\d{9}|447\d{9}|852[4-9]\d{7})$/.test(cleaned)) {
    const e164 = `+${cleaned}`;
    const country = matchCountryFromE164(e164);
    if (country) {
      return {
        type: "international",
        raw,
        e164,
        dialable: true,
        flag: country.flag,
        countryCode: country.code,
        countryZh: country.nameZh,
        countryIso: country.iso,
        brandHint,
        displayNumber: e164,
      };
    }
  }

  if (cleaned.startsWith("+") || cleaned.startsWith("00")) {
    const e164 = cleaned.startsWith("00") ? `+${cleaned.slice(2)}` : cleaned;
    if (/^\+\d{6,18}$/.test(e164)) {
      const country = matchCountryFromE164(e164);
      if (country) {
        return {
          type: "international",
          raw,
          e164,
          dialable: true,
          flag: country.flag,
          countryCode: country.code,
          countryZh: country.nameZh,
          countryIso: country.iso,
          brandHint,
          displayNumber: e164,
        };
      }
      return {
        type: "international",
        raw,
        e164,
        dialable: true,
        flag: "🌐",
        countryCode: null,
        countryZh: "国际号码",
        countryIso: null,
        brandHint,
        displayNumber: e164,
      };
    }
  }

  if (/^\d{7,15}$/.test(cleaned)) {
    const defCountry = getCountryByDialCode(defaultCountryCode);
    const bareCode = (defaultCountryCode || "+353").replace(/^\+/, "");
    if (cleaned.startsWith(bareCode) && cleaned.length >= bareCode.length + 7 && defCountry) {
      const e164 = `+${cleaned}`;
      return {
        type: "international",
        raw,
        e164,
        dialable: true,
        flag: defCountry.flag,
        countryCode: defCountry.code,
        countryZh: defCountry.nameZh,
        countryIso: defCountry.iso,
        brandHint,
        displayNumber: e164,
      };
    }

    if (defCountry) {
      const national =
        defCountry.dropTrunkZero && cleaned.startsWith("0") ? cleaned.slice(1) : cleaned;
      const e164 = `${defCountry.code}${national}`;
      return {
        type: "national",
        raw,
        e164,
        dialable: true,
        flag: defCountry.flag,
        countryCode: defCountry.code,
        countryZh: defCountry.nameZh,
        countryIso: defCountry.iso,
        brandHint,
        displayNumber: `${e164} (${cleaned})`,
      };
    }
  }

  return {
    type: "other",
    raw,
    e164: /^\+?\d{3,20}$/.test(cleaned) ? cleaned : null,
    dialable: /^\+?\d{3,20}$/.test(cleaned),
    flag: "📱",
    countryCode: null,
    countryZh: "未知归属",
    countryIso: null,
    brandHint,
    displayNumber: raw,
  };
}

export function resolveRecipientPhone(
  rawInput: string,
  selectedCountryCode = "+353"
): ResolvedRecipient {
  const cleaned = cleanPhoneFormatting(rawInput);
  if (!cleaned) {
    return { ok: false, error: "号码不能为空" };
  }
  if (!/^\+?\d{3,20}$/.test(cleaned)) {
    return {
      ok: false,
      error: "号码格式无效：请输入手机号（如 0831234567）或带 +国际区号的完整号码（如 +8613800138000）",
    };
  }

  if (!cleaned.startsWith("+") && !cleaned.startsWith("00") && /^\d{3,6}$/.test(cleaned)) {
    return {
      ok: true,
      phone: cleaned,
      flag: "📟",
      countryCode: null,
      countryZh: "短号服务",
      isShortCode: true,
    };
  }

  if (cleaned.startsWith("+") || cleaned.startsWith("00")) {
    const e164 = cleaned.startsWith("00") ? `+${cleaned.slice(2)}` : cleaned;
    if (!/^\+\d{7,18}$/.test(e164)) {
      return { ok: false, error: `国际号码长度无效 (${e164})` };
    }
    const country = matchCountryFromE164(e164);
    return {
      ok: true,
      phone: e164,
      flag: country?.flag ?? "🌐",
      countryCode: country?.code ?? null,
      countryZh: country?.nameZh ?? "国际号码",
      isShortCode: false,
    };
  }

  const country = getCountryByDialCode(selectedCountryCode);
  const code =
    country?.code ?? (selectedCountryCode.startsWith("+") ? selectedCountryCode : `+${selectedCountryCode}`);
  const bareCode = code.replace(/^\+/, "");

  if (cleaned.startsWith(bareCode) && cleaned.length >= bareCode.length + 7) {
    const e164 = `+${cleaned}`;
    return {
      ok: true,
      phone: e164,
      flag: country?.flag ?? "🌐",
      countryCode: code,
      countryZh: country?.nameZh ?? code,
      isShortCode: false,
    };
  }

  const dropZero = country ? country.dropTrunkZero : true;
  const national = dropZero && cleaned.startsWith("0") ? cleaned.slice(1) : cleaned;
  const e164 = `${code}${national}`;
  if (!/^\+\d{7,18}$/.test(e164)) {
    return { ok: false, error: `组合后的号码长度异常 (${e164})，请检查输入` };
  }

  return {
    ok: true,
    phone: e164,
    flag: country?.flag ?? "🌐",
    countryCode: code,
    countryZh: country?.nameZh ?? code,
    isShortCode: false,
  };
}

export function canonicalThreadKey(rawPhone: string, defaultCountryCode = "+353"): string {
  const raw = String(rawPhone ?? "").trim();
  if (!raw) return "unknown";
  if (/[A-Za-z\u4e00-\u9fa5]/.test(raw)) {
    return `alpha:${raw.toLowerCase()}`;
  }
  const info = parseSenderInfo(raw, "", defaultCountryCode);
  return info.e164 ?? cleanPhoneFormatting(raw);
}

export function buildPhoneLookupKeys(rawPhone: string, defaultCountryCode = "+353"): string[] {
  const keys = new Set<string>();
  const raw = String(rawPhone ?? "").trim();
  if (!raw) return [];

  if (/[A-Za-z\u4e00-\u9fa5]/.test(raw)) {
    keys.add(`alpha:${raw.toLowerCase()}`);
    return [...keys];
  }

  const cleaned = cleanPhoneFormatting(raw);
  if (cleaned) keys.add(cleaned);

  const info = parseSenderInfo(raw, "", defaultCountryCode);
  if (info.e164) {
    keys.add(info.e164);
    const digits = info.e164.replace(/^\+/, "");
    keys.add(digits);
    if (digits.length >= 9) {
      keys.add(`tail9:${digits.slice(-9)}`);
    }
  } else {
    const digits = cleaned.replace(/\D/g, "");
    if (digits.length >= 9) {
      keys.add(`tail9:${digits.slice(-9)}`);
    }
  }

  return [...keys];
}
