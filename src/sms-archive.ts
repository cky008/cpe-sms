import { EventEmitter } from "node:events";
import type { ContactStore } from "./contacts.ts";
import { extractVerificationCode } from "./crypto.ts";
import { StorageCipher } from "./encrypted-file.ts";
import { canonicalThreadKey, parseSenderInfo } from "./phone.ts";
import type {
  ArchiveThread,
  ArchivedSmsMessage,
  CpeArchiveStats,
  CpeFullDump,
  EnrichedSmsMessage,
  SmsDirection,
  SmsMessage,
  ThreadDetail,
} from "./types.ts";

interface PersistedSmsArchive {
  version: number;
  lastFullSyncAt: string | null;
  cpeStats: CpeArchiveStats;
  messages: ArchivedSmsMessage[];
}

export interface ArchiveSyncSummary {
  added: number;
  updated: number;
  archiveTotal: number;
  cpeStats: CpeArchiveStats;
  lastFullSyncAt: string;
}

export type RealtimeSmsEventName = "sms:new" | "sms:sent" | "sms:updated";

/**
 * Persistent local historical SMS archive (`./data/sms-archive.json`),
 * encrypted at rest via `StorageCipher` and emitting live SSE events.
 */
export class SmsArchiveStore extends EventEmitter {
  readonly filePath: string;
  readonly contactStore: ContactStore;
  readonly defaultCountryCode: string;
  readonly cipher: StorageCipher;

  messages: Map<string, ArchivedSmsMessage>;
  lastFullSyncAt: string | null;
  cpeStats: CpeArchiveStats;

  constructor(opts: {
    filePath: string;
    contactStore: ContactStore;
    defaultCountryCode?: string;
    cipher?: StorageCipher;
  }) {
    super();
    this.filePath = opts.filePath;
    this.contactStore = opts.contactStore;
    this.defaultCountryCode = opts.defaultCountryCode ?? "+353";
    this.cipher = opts.cipher ?? StorageCipher.fromSecret();

    this.messages = new Map();
    this.lastFullSyncAt = null;
    this.cpeStats = {
      localUnread: 0,
      localInbox: 0,
      localOutbox: 0,
      localMax: 500,
    };

    this.load();
  }

  static makeUid(msg: {
    index: number;
    date: string;
    phone: string;
    direction?: SmsDirection;
  }): string {
    if (msg.index > 0) {
      return `cpe:${msg.index}:${msg.date}:${msg.phone}`;
    }
    return `local:${msg.date}:${msg.phone}:${msg.direction ?? "out"}`;
  }

  load(): void {
    try {
      const raw = this.cipher.readJsonFile<Partial<PersistedSmsArchive>>(this.filePath);
      if (!raw) return;
      if (Array.isArray(raw.messages)) {
        for (const m of raw.messages) {
          if (m && m.uid) this.messages.set(m.uid, m);
        }
      }
      if (raw.lastFullSyncAt) this.lastFullSyncAt = raw.lastFullSyncAt;
      if (raw.cpeStats) this.cpeStats = { ...this.cpeStats, ...raw.cpeStats };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[SmsArchive] Failed to load ${this.filePath}: ${msg}`);
    }
  }

  save(): void {
    const sorted = [...this.messages.values()].sort((a, b) =>
      a.date > b.date ? -1 : a.date < b.date ? 1 : b.index - a.index
    );
    const payload: PersistedSmsArchive = {
      version: 1,
      lastFullSyncAt: this.lastFullSyncAt,
      cpeStats: this.cpeStats,
      messages: sorted,
    };
    this.cipher.writeJsonFile(this.filePath, payload);
  }

  ingestFullDump(dump: CpeFullDump): ArchiveSyncSummary {
    const liveUids = new Set<string>();
    let added = 0;
    let updated = 0;

    for (const raw of dump.messages) {
      const uid = SmsArchiveStore.makeUid(raw);
      liveUids.add(uid);
      const existing = this.messages.get(uid);
      const record: ArchivedSmsMessage = {
        uid,
        index: raw.index,
        phone: raw.phone,
        content: raw.content,
        date: raw.date,
        smstat: raw.smstat,
        smstype: raw.smstype ?? "1",
        curbox: raw.curbox ?? (raw.direction === "out" ? "1" : "0"),
        isUnread: Boolean(raw.isUnread),
        direction: raw.direction,
        verificationCode:
          raw.direction === "in" ? extractVerificationCode(raw.content) : null,
        onCpe: true,
      };
      if (!existing) {
        this.messages.set(uid, record);
        added += 1;
      } else if (
        existing.isUnread !== record.isUnread ||
        existing.smstat !== record.smstat ||
        !existing.onCpe
      ) {
        this.messages.set(uid, record);
        updated += 1;
      }
    }

    for (const [uid, msg] of this.messages.entries()) {
      if (msg.onCpe && msg.index > 0 && !liveUids.has(uid)) {
        msg.onCpe = false;
        msg.isUnread = false;
        updated += 1;
      }
    }

    this.cpeStats = {
      localUnread: dump.localUnread,
      localInbox: dump.localInbox,
      localOutbox: dump.localOutbox,
      localMax: dump.localMax,
    };
    this.lastFullSyncAt = new Date().toISOString();
    this.save();

    const summary: ArchiveSyncSummary = {
      added,
      updated,
      archiveTotal: this.messages.size,
      cpeStats: this.cpeStats,
      lastFullSyncAt: this.lastFullSyncAt,
    };
    this.emit("sms:sync", summary);
    return summary;
  }

  recordRealtimeMessage(
    msg: Partial<SmsMessage> & { phone: string; content: string; date: string },
    eventName: RealtimeSmsEventName = "sms:new"
  ): ArchivedSmsMessage {
    const direction: SmsDirection = msg.direction ?? "in";
    const index = msg.index ?? 0;
    const uid = SmsArchiveStore.makeUid({
      index,
      date: msg.date,
      phone: msg.phone,
      direction,
    });
    const record: ArchivedSmsMessage = {
      uid,
      index,
      phone: msg.phone,
      content: msg.content,
      date: msg.date,
      smstat: msg.smstat ?? (direction === "out" ? "3" : "0"),
      smstype: msg.smstype ?? "1",
      curbox: msg.curbox ?? (direction === "out" ? "1" : "0"),
      isUnread: Boolean(msg.isUnread),
      direction,
      verificationCode:
        direction === "in"
          ? msg.verificationCode ?? extractVerificationCode(msg.content)
          : null,
      onCpe: index > 0,
    };
    this.messages.set(uid, record);
    this.save();
    this.emit(eventName, this.enrichMessage(record));
    return record;
  }

  markReadByCpeIndices(indices: Array<number | string>): void {
    const idSet = new Set(indices.map((i) => Number.parseInt(String(i), 10)));
    let changed = 0;
    for (const msg of this.messages.values()) {
      if (msg.onCpe && idSet.has(msg.index) && msg.isUnread) {
        msg.isUnread = false;
        msg.smstat = "1";
        changed += 1;
      }
    }
    if (changed > 0) {
      this.cpeStats.localUnread = Math.max(0, this.cpeStats.localUnread - changed);
      this.save();
      this.emit("sms:updated", { action: "read", indices: [...idSet] });
    }
  }

  markDeletedByCpeIndices(
    indices: Array<number | string>,
    opts: { removeFromArchive?: boolean } = {}
  ): void {
    const idSet = new Set(indices.map((i) => Number.parseInt(String(i), 10)));
    let changed = 0;
    for (const [uid, msg] of this.messages.entries()) {
      if (idSet.has(msg.index)) {
        if (opts.removeFromArchive) {
          this.messages.delete(uid);
        } else {
          msg.onCpe = false;
          msg.isUnread = false;
        }
        changed += 1;
      }
    }
    if (changed > 0) {
      this.save();
      this.emit("sms:updated", { action: "deleted", indices: [...idSet] });
    }
  }

  deleteArchiveUids(uids: string[]): number {
    let removed = 0;
    for (const uid of uids) {
      if (this.messages.delete(uid)) removed += 1;
    }
    if (removed > 0) {
      this.save();
      this.emit("sms:updated", { action: "archive_deleted", uids });
    }
    return removed;
  }

  enrichMessage(msg: ArchivedSmsMessage): EnrichedSmsMessage {
    const sender = parseSenderInfo(msg.phone, msg.content, this.defaultCountryCode);
    const contact = this.contactStore.resolvePhone(msg.phone);
    return {
      ...msg,
      threadKey: canonicalThreadKey(msg.phone, this.defaultCountryCode),
      sender,
      contact: contact ? { id: contact.id, name: contact.name, note: contact.note } : null,
    };
  }

  listThreads(opts: { search?: string; filter?: "all" | "unread" | "otp" } = {}): ArchiveThread[] {
    const q = (opts.search ?? "").trim().toLowerCase();
    const filter = opts.filter ?? "all";
    const map = new Map<string, ArchiveThread>();

    const allSorted = [...this.messages.values()].sort((a, b) =>
      a.date > b.date ? -1 : a.date < b.date ? 1 : b.index - a.index
    );

    for (const msg of allSorted) {
      const key = canonicalThreadKey(msg.phone, this.defaultCountryCode);
      const sender = parseSenderInfo(msg.phone, msg.content, this.defaultCountryCode);
      const contact = this.contactStore.resolvePhone(msg.phone);

      let thread = map.get(key);
      if (!thread) {
        const displayName =
          contact?.name ??
          (sender.type === "alphanumeric"
            ? msg.phone
            : sender.brandHint
              ? `${msg.phone} (${sender.brandHint})`
              : sender.e164 ?? msg.phone);

        thread = {
          threadKey: key,
          phone: msg.phone,
          replyPhone: sender.dialable ? sender.e164 ?? msg.phone : null,
          dialable: sender.dialable,
          sender,
          contact: contact ? { id: contact.id, name: contact.name, note: contact.note } : null,
          displayName,
          unreadCount: 0,
          totalCount: 0,
          hasOtp: false,
          latestOtp: null,
          latestMessage: msg,
        };
        map.set(key, thread);
      } else if (!thread.sender.brandHint && sender.brandHint && !thread.contact) {
        thread.sender.brandHint = sender.brandHint;
        if (thread.sender.type !== "alphanumeric") {
          thread.displayName = `${thread.phone} (${sender.brandHint})`;
        }
      }

      thread.totalCount += 1;
      if (msg.isUnread) thread.unreadCount += 1;
      if (msg.verificationCode) {
        thread.hasOtp = true;
        if (!thread.latestOtp) thread.latestOtp = msg.verificationCode;
      }

      if (q && !thread.matchedPreview) {
        if (
          msg.content.toLowerCase().includes(q) ||
          Boolean(msg.verificationCode && msg.verificationCode.includes(q))
        ) {
          thread.matchedPreview = msg.content;
        }
      }
    }

    let threads = [...map.values()];

    if (filter === "unread") {
      threads = threads.filter((t) => t.unreadCount > 0);
    } else if (filter === "otp") {
      threads = threads.filter((t) => t.hasOtp);
    }

    if (q) {
      threads = threads.filter(
        (t) =>
          t.displayName.toLowerCase().includes(q) ||
          t.phone.toLowerCase().includes(q) ||
          Boolean(t.sender.e164 && t.sender.e164.toLowerCase().includes(q)) ||
          Boolean(t.sender.countryZh && t.sender.countryZh.toLowerCase().includes(q)) ||
          Boolean(t.matchedPreview)
      );
    }

    return threads;
  }

  getThreadDetail(targetKeyOrPhone: string): ThreadDetail {
    const wantedKey = targetKeyOrPhone.startsWith("alpha:")
      ? targetKeyOrPhone
      : canonicalThreadKey(targetKeyOrPhone, this.defaultCountryCode);

    const msgs = [...this.messages.values()]
      .filter((m) => canonicalThreadKey(m.phone, this.defaultCountryCode) === wantedKey)
      .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : a.index - b.index))
      .map((m) => this.enrichMessage(m));

    const samplePhone = msgs[msgs.length - 1]?.phone ?? targetKeyOrPhone.replace(/^alpha:/, "");
    const sampleContent =
      [...msgs].reverse().find((m) => Boolean(m.sender?.brandHint))?.content ?? "";
    const sender = parseSenderInfo(samplePhone, sampleContent, this.defaultCountryCode);
    const contact = this.contactStore.resolvePhone(samplePhone);

    return {
      threadKey: wantedKey,
      phone: samplePhone,
      replyPhone: sender.dialable ? sender.e164 ?? samplePhone : null,
      dialable: sender.dialable,
      sender,
      contact: contact ? { id: contact.id, name: contact.name, note: contact.note } : null,
      messages: msgs,
    };
  }
}
