import crypto from "node:crypto";
import { StorageCipher } from "./encrypted-file.ts";
import { buildPhoneLookupKeys, resolveRecipientPhone } from "./phone.ts";
import type { ContactRecord } from "./types.ts";

export interface ParsedVcardEntry {
  name: string;
  phones: string[];
  org?: string;
}

export interface VcardImportSummary {
  parsed: number;
  added: number;
  updated: number;
  total: number;
}

function decodeQuotedPrintableUtf8(input: string): string {
  const joined = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const encoded = Buffer.from(joined[i]!, "utf8");
      for (const b of encoded) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function unescapeVcardValue(val: string): string {
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
 */
export function parseVcardContacts(vcfText: string): ParsedVcardEntry[] {
  if (!vcfText) return [];

  const rawLines = vcfText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1]! += line.slice(1);
    } else if (
      lines.length > 0 &&
      /ENCODING=QUOTED-PRINTABLE/i.test(lines[lines.length - 1]!) &&
      lines[lines.length - 1]!.endsWith("=")
    ) {
      lines[lines.length - 1] = lines[lines.length - 1]!.slice(0, -1) + line;
    } else {
      lines.push(line);
    }
  }

  const results: ParsedVcardEntry[] = [];
  let inCard = false;
  let fn = "";
  let structuredName = "";
  let org = "";
  let phones: string[] = [];

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

    const propParts = rawProp.replace(/^[A-Za-z0-9_-]+\./, "").split(";");
    const propName = (propParts[0] ?? "").toUpperCase();
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
      const cleanedTel = rawVal.replace(/^tel:/i, "").replace(/[^\d+]/g, "");
      if (cleanedTel.length >= 3) {
        phones.push(cleanedTel);
      }
    }
  }

  return results;
}

interface PersistedContactBook {
  version: number;
  contacts: ContactRecord[];
}

/**
 * Local contact directory supporting manual nicknames and iPhone `.vcf` imports,
 * persisted atomically and encrypted at rest via `StorageCipher`.
 */
export class ContactStore {
  readonly filePath: string;
  readonly defaultCountryCode: string;
  readonly cipher: StorageCipher;
  contacts: ContactRecord[];
  #lookupMap: Map<string, ContactRecord>;

  constructor(
    filePath: string,
    defaultCountryCode = "+353",
    cipher: StorageCipher = StorageCipher.fromSecret()
  ) {
    this.filePath = filePath;
    this.defaultCountryCode = defaultCountryCode;
    this.cipher = cipher;
    this.contacts = [];
    this.#lookupMap = new Map();
    this.load();
  }

  load(): void {
    try {
      const parsed = this.cipher.readJsonFile<Partial<PersistedContactBook>>(this.filePath);
      if (parsed && Array.isArray(parsed.contacts)) {
        this.contacts = parsed.contacts;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ContactStore] Failed to parse ${this.filePath}: ${msg}`);
    }
    this.#rebuildIndex();
  }

  save(): void {
    const payload: PersistedContactBook = { version: 1, contacts: this.contacts };
    this.cipher.writeJsonFile(this.filePath, payload);
  }

  #rebuildIndex(): void {
    this.#lookupMap.clear();
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

  resolvePhone(rawPhone: string): ContactRecord | null {
    for (const key of buildPhoneLookupKeys(rawPhone, this.defaultCountryCode)) {
      const hit = this.#lookupMap.get(key);
      if (hit) return hit;
    }
    return null;
  }

  upsertManualContact(input: { phone: string; name: string; note?: string }): ContactRecord {
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
      if (input.note !== undefined) existing.note = input.note.trim() || undefined;
      if (!existing.phones.includes(normalizedPhone)) {
        existing.phones.unshift(normalizedPhone);
      }
      existing.source = "manual";
      existing.updatedAt = now;
      this.#rebuildIndex();
      this.save();
      return existing;
    }

    const created: ContactRecord = {
      id: crypto.randomUUID(),
      name,
      phones: [normalizedPhone],
      note: input.note?.trim() || undefined,
      source: "manual",
      updatedAt: now,
    };
    this.contacts.unshift(created);
    this.#rebuildIndex();
    this.save();
    return created;
  }

  importVcard(vcfText: string): VcardImportSummary {
    const parsed = parseVcardContacts(vcfText);
    let added = 0;
    let updated = 0;
    const now = new Date().toISOString();

    for (const item of parsed) {
      const normalizedPhones = item.phones.map((p) => {
        const r = resolveRecipientPhone(p, this.defaultCountryCode);
        return r.ok ? r.phone : p;
      });

      let matched: ContactRecord | null = null;
      for (const np of normalizedPhones) {
        matched = this.resolvePhone(np);
        if (matched) break;
      }

      if (matched) {
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

  deleteContact(id: string): boolean {
    const before = this.contacts.length;
    this.contacts = this.contacts.filter((c) => c.id !== id);
    if (this.contacts.length !== before) {
      this.#rebuildIndex();
      this.save();
      return true;
    }
    return false;
  }

  search(query = "", limit = 50): ContactRecord[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.contacts.slice(0, limit);
    return this.contacts
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          Boolean(c.note && c.note.toLowerCase().includes(q)) ||
          c.phones.some((p) => p.toLowerCase().includes(q))
      )
      .slice(0, limit);
  }
}
