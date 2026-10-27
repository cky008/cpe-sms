import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildPhoneLookupKeys, resolveRecipientPhone } from "./phone.js";

/**
 * Decode RFC 2045 Quoted-Printable UTF-8 strings commonly produced by vCard 2.1/3.0 exports.
 *
 * @param {string} input
 * @returns {string}
 */
function decodeQuotedPrintableUtf8(input) {
  // Remove soft line breaks `=\r\n` or `=\n`
  const joined = input.replace(/=\r?\n/g, "");
  /** @type {number[]} */
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const encoded = Buffer.from(joined[i], "utf8");
      for (const b of encoded) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Unescape vCard backslash escapes (`\n`, `\,`, `\;`, `\\`).
 *
 * @param {string} val
 * @returns {string}
 */
function unescapeVcardValue(val) {
  return val
    .replace(/\\[nN]/g, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/**
 * Parse an Apple iPhone / macOS / iCloud / Android `.vcf` (vCard 2.1 / 3.0 / 4.0) file
 * into clean contact entries `{ name, phones, org }`.
 *
 * @param {string} vcfText
 * @returns {Array<{ name: string, phones: string[], org?: string }>}
 */
export function parseVcardContacts(vcfText) {
  if (!vcfText) return [];

  // Unfold standard RFC 2426 / 6350 folded lines (`CRLF + space/tab`)
  // AND Quoted-Printable soft-wrapped lines (`=` at end of line)
  const rawLines = vcfText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  /** @type {string[]} */
  const lines = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (
      lines.length > 0 &&
      /ENCODING=QUOTED-PRINTABLE/i.test(lines[lines.length - 1]) &&
      lines[lines.length - 1].endsWith("=")
    ) {
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) + line;
    } else {
      lines.push(line);
    }
  }

  /** @type {Array<{ name: string, phones: string[], org?: string }>} */
  const results = [];
  let inCard = false;
  let fn = "";
  let structuredName = "";
  let org = "";
  /** @type {string[]} */
  let phones = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^BEGIN:VCARD$/i.test(line)) {
      inCard = true;
      fn = "";
      structuredName = "";
      org = "";
      phones = [];
      continue;
    }

    if (/^END:VCARD$/i.test(line)) {
      if (inCard) {
        const finalName = (fn || structuredName || org).trim();
        const uniquePhones = [...new Set(phones.filter(Boolean))];
        if (finalName && uniquePhones.length > 0) {
          results.push({
            name: finalName,
            phones: uniquePhones,
            org: org || undefined,
          });
        }
      }
      inCard = false;
      continue;
    }

    if (!inCard) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;

    const rawProp = line.slice(0, colonIdx);
    let rawVal = line.slice(colonIdx + 1);

    // Strip Apple `item1.` group prefixes (`item1.TEL;...` -> `TEL;...`)
    const propParts = rawProp.replace(/^[A-Za-z0-9_-]+\./, "").split(";");
    const propName = propParts[0].toUpperCase();
    const isQuotedPrintable = propParts.some((p) => /QUOTED-PRINTABLE/i.test(p));

    if (isQuotedPrintable) {
      rawVal = decodeQuotedPrintableUtf8(rawVal);
    }

    if (propName === "FN") {
      fn = unescapeVcardValue(rawVal);
    } else if (propName === "N") {
      const parts = rawVal.split(";").map(unescapeVcardValue);
      const [family = "", given = "", middle = "", prefix = "", suffix = ""] = parts;
      const hasCjk = /[\u4e00-\u9fa5]/.test(family + given);
      structuredName = hasCjk
        ? `${family}${middle}${given}`.trim()
        : [prefix, given, middle, family, suffix].filter(Boolean).join(" ").trim();
    } else if (propName === "ORG") {
      org = unescapeVcardValue(rawVal.split(";")[0] ?? "");
    } else if (propName === "TEL") {
      const cleanedTel = rawVal
        .replace(/^tel:/i, "")
        .replace(/[^\d+]/g, "");
      if (cleanedTel.length >= 3) {
        phones.push(cleanedTel);
      }
    }
  }

  return results;
}

/**
 * Local contact directory supporting manual nicknames and iPhone `.vcf` imports,
 * persisted atomically in `./data/contacts.json`.
 */
export class ContactStore {
  /**
   * @param {string} filePath
   * @param {string} [defaultCountryCode="+353"]
   */
  constructor(filePath, defaultCountryCode = "+353") {
    this.filePath = filePath;
    this.defaultCountryCode = defaultCountryCode;
    /**
     * @type {Array<{
     *   id: string,
     *   name: string,
     *   phones: string[],
     *   note?: string,
     *   source: "manual" | "vcard",
     *   updatedAt: string
     * }>}
     */
    this.contacts = [];
    /** @type {Map<string, { id: string, name: string, phones: string[], note?: string, source: string }>} */
    this.#lookupMap = new Map();
    this.load();
  }

  #lookupMap;

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.#rebuildIndex();
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (Array.isArray(parsed.contacts)) {
        this.contacts = parsed.contacts;
      }
    } catch (err) {
      console.warn(`[ContactStore] Failed to parse ${this.filePath}:`, err.message);
    }
    this.#rebuildIndex();
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, contacts: this.contacts }, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );
    fs.renameSync(tmp, this.filePath);
  }

  #rebuildIndex() {
    this.#lookupMap.clear();
    // Index vCard contacts first, then manual contacts last so manual nicknames take precedence!
    const ordered = [...this.contacts].sort((a, b) =>
      a.source === b.source ? 0 : a.source === "manual" ? 1 : -1
    );
    for (const c of ordered) {
      for (const p of c.phones) {
        for (const key of buildPhoneLookupKeys(p, this.defaultCountryCode)) {
          this.#lookupMap.set(key, c);
        }
      }
    }
  }

  /**
   * Look up a contact matching `rawPhone` (handles `+353...` <-> `083...` automatically).
   *
   * @param {string} rawPhone
   */
  resolvePhone(rawPhone) {
    for (const key of buildPhoneLookupKeys(rawPhone, this.defaultCountryCode)) {
      const hit = this.#lookupMap.get(key);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Add or update a manual contact / remark for a phone number.
   *
   * @param {{ phone: string, name: string, note?: string }} input
   */
  upsertManualContact(input) {
    const name = String(input.name ?? "").trim();
    const rawPhone = String(input.phone ?? "").trim();
    if (!name || !rawPhone) {
      throw new Error("联系人姓名与号码不能为空");
    }

    const resolved = resolveRecipientPhone(rawPhone, this.defaultCountryCode);
    const normalizedPhone = resolved.ok ? resolved.phone : rawPhone;

    const existing = this.resolvePhone(normalizedPhone);
    const now = new Date().toISOString();

    if (existing) {
      existing.name = name;
      if (input.note !== undefined) existing.note = input.note;
      if (!existing.phones.includes(normalizedPhone)) {
        existing.phones.unshift(normalizedPhone);
      }
      existing.source = "manual";
      existing.updatedAt = now;
      this.#rebuildIndex();
      this.save();
      return existing;
    }

    const created = {
      id: crypto.randomUUID(),
      name,
      phones: [normalizedPhone],
      note: input.note?.trim() || undefined,
      source: /** @type {const} */ ("manual"),
      updatedAt: now,
    };
    this.contacts.unshift(created);
    this.#rebuildIndex();
    this.save();
    return created;
  }

  /**
   * Import contacts from an iPhone / standard `.vcf` vCard file.
   * Merges cleanly without overwriting user's manual nicknames.
   *
   * @param {string} vcfText
   */
  importVcard(vcfText) {
    const parsed = parseVcardContacts(vcfText);
    let added = 0;
    let updated = 0;
    const now = new Date().toISOString();

    for (const item of parsed) {
      const normalizedPhones = item.phones.map((p) => {
        const r = resolveRecipientPhone(p, this.defaultCountryCode);
        return r.ok ? r.phone : p;
      });

      let matched = null;
      for (const np of normalizedPhones) {
        matched = this.resolvePhone(np);
        if (matched) break;
      }

      if (matched) {
        // Preserve manual remark name, only enrich phone list
        if (matched.source !== "manual") {
          matched.name = item.name;
        }
        for (const np of normalizedPhones) {
          if (!matched.phones.includes(np)) matched.phones.push(np);
        }
        matched.updatedAt = now;
        updated += 1;
      } else {
        this.contacts.push({
          id: crypto.randomUUID(),
          name: item.name,
          phones: [...new Set(normalizedPhones)],
          note: item.org || undefined,
          source: "vcard",
          updatedAt: now,
        });
        added += 1;
        this.#rebuildIndex();
      }
    }

    this.#rebuildIndex();
    this.save();
    return { parsed: parsed.length, added, updated, total: this.contacts.length };
  }

  /**
   * Delete a contact by `id`.
   *
   * @param {string} id
   */
  deleteContact(id) {
    const before = this.contacts.length;
    this.contacts = this.contacts.filter((c) => c.id !== id);
    if (this.contacts.length !== before) {
      this.#rebuildIndex();
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Search contacts by name, note, or phone substring.
   *
   * @param {string} [query=""]
   * @param {number} [limit=50]
   */
  search(query = "", limit = 50) {
    const q = query.trim().toLowerCase();
    if (!q) return this.contacts.slice(0, limit);
    return this.contacts
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.note && c.note.toLowerCase().includes(q)) ||
          c.phones.some((p) => p.toLowerCase().includes(q))
      )
      .slice(0, limit);
  }
}
