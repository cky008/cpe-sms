import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { extractVerificationCode } from "./crypto.js";
import { canonicalThreadKey, parseSenderInfo } from "./phone.js";

/**
 * Persistent local historical SMS archive (`./data/sms-archive.json`).
 *
 * - Stores ALL historical inbox & outbox messages pulled from the CPE so the Web UI
 *   loads instantaneously (<10ms) and retains history even after old SMS are deleted from
 *   the CPE's 500-message storage.
 * - Emits live events (`"sms:new"`, `"sms:sent"`, `"sms:updated"`, `"sms:sync"`) consumed
 *   by the real-time Server-Sent Events (`/api/events`) Web UI stream.
 */
export class SmsArchiveStore extends EventEmitter {
  /**
   * @param {{
   *   filePath: string,
   *   contactStore: import("./contacts.js").ContactStore,
   *   defaultCountryCode?: string
   * }} opts
   */
  constructor(opts) {
    super();
    this.filePath = opts.filePath;
    this.contactStore = opts.contactStore;
    this.defaultCountryCode = opts.defaultCountryCode ?? "+353";

    /**
     * @type {Map<string, {
     *   uid: string,
     *   index: number,
     *   phone: string,
     *   content: string,
     *   date: string,
     *   smstat: string,
     *   smstype: string,
     *   curbox: string,
     *   isUnread: boolean,
     *   direction: "in" | "out",
     *   verificationCode: string | null,
     *   onCpe: boolean
     * }>}
     */
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

  /**
   * Deterministic unique key across CPE reboots or index reuse.
   *
   * @param {{ index: number, date: string, phone: string, direction?: string }} msg
   */
  static makeUid(msg) {
    if (msg.index > 0) {
      return `cpe:${msg.index}:${msg.date}:${msg.phone}`;
    }
    return `local:${msg.date}:${msg.phone}:${msg.direction ?? "out"}`;
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (Array.isArray(raw.messages)) {
        for (const m of raw.messages) {
          if (m && m.uid) this.messages.set(m.uid, m);
        }
      }
      if (raw.lastFullSyncAt) this.lastFullSyncAt = raw.lastFullSyncAt;
      if (raw.cpeStats) this.cpeStats = { ...this.cpeStats, ...raw.cpeStats };
    } catch (err) {
      console.warn(`[SmsArchive] Failed to load ${this.filePath}:`, err.message);
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const sorted = [...this.messages.values()].sort((a, b) =>
      a.date > b.date ? -1 : a.date < b.date ? 1 : b.index - a.index
    );
    const payload = JSON.stringify(
      {
        version: 1,
        lastFullSyncAt: this.lastFullSyncAt,
        cpeStats: this.cpeStats,
        messages: sorted,
      },
      null,
      2
    );
    fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /**
   * Merge a full CPE history dump (`fetchAllMessages`) into the archive.
   *
   * @param {{
   *   localUnread: number,
   *   localInbox: number,
   *   localOutbox: number,
   *   localMax: number,
   *   messages: Array<any>
   * }} dump
   */
  ingestFullDump(dump) {
    const liveUids = new Set();
    let added = 0;
    let updated = 0;

    for (const raw of dump.messages) {
      const uid = SmsArchiveStore.makeUid(raw);
      liveUids.add(uid);
      const existing = this.messages.get(uid);
      const record = {
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

    // Mark archived messages no longer present on CPE as `onCpe = false` (retaining history!)
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

    const summary = {
      added,
      updated,
      archiveTotal: this.messages.size,
      cpeStats: this.cpeStats,
      lastFullSyncAt: this.lastFullSyncAt,
    };
    this.emit("sms:sync", summary);
    return summary;
  }

  /**
   * Record a single real-time incoming or outgoing SMS and broadcast via SSE.
   *
   * @param {any} msg
   * @param {"sms:new" | "sms:sent"} [eventName="sms:new"]
   */
  recordRealtimeMessage(msg, eventName = "sms:new") {
    const uid = SmsArchiveStore.makeUid(msg);
    const record = {
      uid,
      index: msg.index ?? 0,
      phone: msg.phone,
      content: msg.content,
      date: msg.date,
      smstat: msg.smstat ?? (msg.direction === "out" ? "3" : "0"),
      smstype: msg.smstype ?? "1",
      curbox: msg.curbox ?? (msg.direction === "out" ? "1" : "0"),
      isUnread: Boolean(msg.isUnread),
      direction: msg.direction ?? "in",
      verificationCode:
        (msg.direction ?? "in") === "in"
          ? msg.verificationCode ?? extractVerificationCode(msg.content)
          : null,
      onCpe: Boolean(msg.index > 0),
    };
    this.messages.set(uid, record);
    this.save();
    this.emit(eventName, this.enrichMessage(record));
    return record;
  }

  /**
   * Update archive read status when messages are marked read on CPE.
   *
   * @param {Array<number | string>} indices
   */
  markReadByCpeIndices(indices) {
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

  /**
   * Handle deletion of SMS messages (either from CPE only or from both CPE and local archive).
   *
   * @param {Array<number | string>} indices
   * @param {{ removeFromArchive?: boolean }} [opts]
   */
  markDeletedByCpeIndices(indices, opts = {}) {
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

  /**
   * Delete messages by `uid` from the local archive.
   *
   * @param {string[]} uids
   */
  deleteArchiveUids(uids) {
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

  /**
   * Enrich a message with sender country metadata and matched contact name.
   *
   * @param {any} msg
   */
  enrichMessage(msg) {
    const sender = parseSenderInfo(msg.phone, msg.content, this.defaultCountryCode);
    const contact = this.contactStore.resolvePhone(msg.phone);
    return {
      ...msg,
      threadKey: canonicalThreadKey(msg.phone, this.defaultCountryCode),
      sender,
      contact: contact ? { id: contact.id, name: contact.name, note: contact.note } : null,
    };
  }

  /**
   * List aggregated conversation threads across ALL historical messages, with optional search
   * and filter (`"all" | "unread" | "otp"`).
   *
   * @param {{ search?: string, filter?: "all" | "unread" | "otp" }} [opts]
   */
  listThreads(opts = {}) {
    const q = (opts.search ?? "").trim().toLowerCase();
    const filter = opts.filter ?? "all";

    /** @type {Map<string, {
     *   threadKey: string,
     *   phone: string,
     *   replyPhone: string | null,
     *   dialable: boolean,
     *   sender: ReturnType<typeof parseSenderInfo>,
     *   contact: { id: string, name: string, note?: string } | null,
     *   displayName: string,
     *   unreadCount: number,
     *   totalCount: number,
     *   hasOtp: boolean,
     *   latestOtp: string | null,
     *   latestMessage: any,
     *   matchedPreview?: string
     * }>} */
    const map = new Map();

    // Sort newest first so first seen per thread is the latest message
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
          (msg.verificationCode && msg.verificationCode.includes(q))
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
          (t.sender.e164 && t.sender.e164.toLowerCase().includes(q)) ||
          (t.sender.countryZh && t.sender.countryZh.toLowerCase().includes(q)) ||
          Boolean(t.matchedPreview)
      );
    }

    return threads;
  }

  /**
   * Get all chronological messages belonging to a thread (`threadKey` or raw `phone`).
   *
   * @param {string} targetKeyOrPhone
   */
  getThreadDetail(targetKeyOrPhone) {
    const wantedKey = targetKeyOrPhone.startsWith("alpha:") || targetKeyOrPhone.startsWith("+")
      ? (targetKeyOrPhone.startsWith("alpha:")
          ? targetKeyOrPhone
          : canonicalThreadKey(targetKeyOrPhone, this.defaultCountryCode))
      : canonicalThreadKey(targetKeyOrPhone, this.defaultCountryCode);

    const msgs = [...this.messages.values()]
      .filter((m) => canonicalThreadKey(m.phone, this.defaultCountryCode) === wantedKey)
      .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : a.index - b.index))
      .map((m) => this.enrichMessage(m));

    const samplePhone = msgs[msgs.length - 1]?.phone ?? targetKeyOrPhone.replace(/^alpha:/, "");
    const sampleContent =
      [...msgs].reverse().find((m) => m.sender?.brandHint)?.content ?? "";
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
