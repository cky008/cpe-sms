import { huaweiXssDecode, stripInvalidControlChars } from "./crypto.js";

/**
 * Extract the decoded inner text of the first matching `<tag>...</tag>` in an XML string.
 *
 * @param {string} xml
 * @param {string} tag
 * @returns {string | null}
 */
export function getXmlTag(xml, tag) {
  if (!xml) return null;
  const clean = stripInvalidControlChars(xml);
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = clean.match(re);
  if (!match) return null;
  return huaweiXssDecode(match[1].trim());
}

/**
 * Extract all `<tag>...</tag>` raw inner XML blocks (e.g. `<message>...</message>`).
 * Note: For `<message>` content fields, preserve exact whitespace inside `<content>`
 * while decoding Huawei XML/XSS entities.
 *
 * @param {string} xml
 * @param {string} tag
 * @returns {string[]}
 */
export function getXmlBlocks(xml, tag) {
  if (!xml) return [];
  const clean = stripInvalidControlChars(xml);
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi");
  return [...clean.matchAll(re)].map((m) => m[1]);
}

/**
 * Extract `<content>...</content>` without trimming leading/trailing message whitespace
 * (except CRLF normalization).
 *
 * @param {string} xmlBlock
 * @param {string} [tag="content"]
 * @returns {string}
 */
export function getXmlTextPreserve(xmlBlock, tag = "content") {
  if (!xmlBlock) return "";
  const clean = stripInvalidControlChars(xmlBlock);
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = clean.match(re);
  if (!match) return "";
  return huaweiXssDecode(match[1]).replace(/\r\n/g, "\n");
}

/**
 * Check if a Huawei XML response represents `<error><code>...</code>...</error>`.
 *
 * @param {string} xml
 * @returns {{ code: string, message: string, remainCount: number | null, waitTime: number | null } | null}
 */
export function parseXmlError(xml) {
  if (!xml || !/<error>/i.test(xml)) return null;
  const code = getXmlTag(xml, "code");
  if (!code) return null;
  const message = getXmlTag(xml, "message") ?? "";
  const remainRaw = getXmlTag(xml, "remaincount");
  const waitRaw = getXmlTag(xml, "waittime");
  return {
    code,
    message,
    remainCount: remainRaw !== null && remainRaw !== "" ? Number.parseInt(remainRaw, 10) : null,
    waitTime: waitRaw !== null && waitRaw !== "" ? Number.parseInt(waitRaw, 10) : null,
  };
}

/**
 * Convert a nested JS value into Huawei HiLink XML body (`main_crypto.js` `jsonToXml`).
 * Caller is responsible for escaping field values that require `huaweiXssEncode` or XML escaping.
 *
 * @param {string} tag
 * @param {unknown} value
 * @returns {string}
 */
export function jsonToXml(tag, value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return `<${tag}>${value}</${tag}>`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonToXml(tag, item)).join("");
  }
  if (typeof value === "object") {
    const inner = Object.entries(value)
      .map(([k, v]) => jsonToXml(k, v))
      .join("");
    return `<${tag}>${inner}</${tag}>`;
  }
  return "";
}

/**
 * Build a full `<?xml version="1.0" encoding="UTF-8"?><request>...</request>` document.
 *
 * @param {Record<string, unknown>} data
 * @returns {string}
 */
export function buildXmlRequest(data) {
  return `<?xml version="1.0" encoding="UTF-8"?>${jsonToXml("request", data)}`;
}

/**
 * Escape basic XML special characters for fields like `<Phone>` or `<Index>`.
 *
 * @param {string | number} value
 * @returns {string}
 */
export function escapeXmlBasic(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

/**
 * Format a `Date` object as `yyyy-MM-dd HH:mm:ss` in local timezone, matching Huawei WebUI.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function formatHuaweiDate(date = new Date()) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
