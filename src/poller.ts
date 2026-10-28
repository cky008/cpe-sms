import { EventEmitter } from "node:events";
import type { HuaweiCpeClient } from "./cpe-client.ts";
import { extractVerificationCode } from "./crypto.ts";
import type { SmsArchiveStore } from "./sms-archive.ts";
import type { StateStore } from "./state-store.ts";
import type { CpeFullDump, SmsMessage } from "./types.ts";

export interface SmsPollerOptions {
  cpeClient: HuaweiCpeClient;
  stateStore: StateStore;
  archiveStore?: SmsArchiveStore;
  pollIntervalMs?: number;
  fullSyncIntervalMs?: number;
  seedExistingOnStart?: boolean;
  autoMarkRead?: boolean;
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Zero-conflict SMS poller:
 * 1. Polls unauthenticated `/api/monitoring/check-notifications` every `pollIntervalMs` (default 5s).
 * 2. Opens an ephemeral encrypted session ONLY when `UnreadMessage` changes or when `fullSyncIntervalMs`
 *    elapses while the WebUI is idle (`State != 0`), so browser access to `http://192.168.8.1/#/sms`
 *    is never interrupted.
 */
export class SmsPoller extends EventEmitter {
  readonly cpeClient: HuaweiCpeClient;
  readonly stateStore: StateStore;
  readonly archiveStore: SmsArchiveStore | null;
  readonly pollIntervalMs: number;
  readonly fullSyncIntervalMs: number;
  readonly seedExistingOnStart: boolean;
  readonly autoMarkRead: boolean;
  readonly webhookUrl: string;
  readonly fetchImpl: typeof fetch;

  #timer: ReturnType<typeof setTimeout> | null;
  #running: boolean;
  #syncing: boolean;
  #lastFullSyncAt: number;

  constructor(opts: SmsPollerOptions) {
    super();
    this.cpeClient = opts.cpeClient;
    this.stateStore = opts.stateStore;
    this.archiveStore = opts.archiveStore ?? null;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.fullSyncIntervalMs = opts.fullSyncIntervalMs ?? 60000;
    this.seedExistingOnStart = opts.seedExistingOnStart ?? true;
    this.autoMarkRead = opts.autoMarkRead ?? false;
    this.webhookUrl = opts.webhookUrl ?? "";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;

    this.#timer = null;
    this.#running = false;
    this.#syncing = false;
    this.#lastFullSyncAt = 0;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;

    if (this.archiveStore && !this.archiveStore.lastFullSyncAt) {
      await this.syncFullHistory({ isInitial: true });
    } else {
      await this.syncOnce({ isInitial: true });
    }
    this.#scheduleNext();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #scheduleNext(): void {
    if (!this.#running) return;
    this.#timer = setTimeout(async () => {
      await this.tick();
      this.#scheduleNext();
    }, this.pollIntervalMs);
  }

  async tick(): Promise<void> {
    if (this.#syncing) return;
    try {
      const notif = await this.cpeClient.checkNotifications();
      const prevUnread = this.stateStore.data.lastUnreadCount;
      const now = Date.now();

      this.emit("status:update", {
        unreadMessages: notif.unreadMessages,
        smsStorageFull: notif.smsStorageFull,
        timestamp: new Date().toISOString(),
      });

      const unreadIncreased = prevUnread !== null && notif.unreadMessages > prevUnread;
      const unreadChangedFirstTime = prevUnread === null;
      const dueForIdleSync = now - this.#lastFullSyncAt >= this.fullSyncIntervalMs;

      if (unreadIncreased || unreadChangedFirstTime) {
        await this.syncOnce({ respectBrowserSession: false });
      } else if (dueForIdleSync) {
        await this.syncOnce({ respectBrowserSession: true });
      }

      this.stateStore.setLastUnreadCount(notif.unreadMessages);
    } catch (err) {
      this.emit("error", err);
    }
  }

  async syncFullHistory(
    opts: { isInitial?: boolean; respectBrowserSession?: boolean } = {}
  ): Promise<CpeFullDump | null> {
    if (this.#syncing) return null;
    this.#syncing = true;
    try {
      const dump = await this.cpeClient.fetchAllMessages({
        respectBrowserSession: Boolean(opts.respectBrowserSession),
      });
      if (!dump) return null;

      this.#lastFullSyncAt = Date.now();
      this.stateStore.setLastUnreadCount(dump.localUnread);

      const inboxMessages = dump.messages.filter((m) => m.direction === "in");

      if (!this.stateStore.data.seeded && this.seedExistingOnStart) {
        const existingIndices = inboxMessages.map((m) => m.index);
        this.stateStore.completeSeed(existingIndices, dump.localUnread);
        if (this.archiveStore) {
          this.archiveStore.ingestFullDump(dump);
        }
        this.emit("seeded", {
          seededCount: dump.messages.length,
          unreadMessages: dump.localUnread,
          localInbox: dump.localInbox,
          localMax: dump.localMax,
        });
        return dump;
      }

      const knownMax =
        this.stateStore.data.notifiedIndices.length > 0
          ? Math.max(...this.stateStore.data.notifiedIndices)
          : 0;
      const freshMessages = inboxMessages
        .filter((m) => m.index > knownMax && !this.stateStore.isNotified(m.index))
        .sort((a, b) => a.index - b.index);

      if (this.archiveStore) {
        this.archiveStore.ingestFullDump(dump);
      }

      for (const msg of freshMessages) {
        const enriched: SmsMessage = {
          ...msg,
          verificationCode: extractVerificationCode(msg.content),
        };
        this.stateStore.markNotified([msg.index]);
        this.emit("new_sms", enriched);
      }

      return dump;
    } catch (err) {
      this.emit("error", err);
      return null;
    } finally {
      this.#syncing = false;
    }
  }

  async syncOnce(
    opts: { isInitial?: boolean; respectBrowserSession?: boolean } = {}
  ): Promise<SmsMessage[]> {
    if (this.#syncing) return [];
    this.#syncing = true;
    try {
      const inbox = await this.cpeClient.fetchRecentInboxMessages({
        count: 40,
        unreadOnly: false,
        respectBrowserSession: Boolean(opts.respectBrowserSession),
      });

      if (!inbox) {
        return [];
      }

      this.#lastFullSyncAt = Date.now();
      this.stateStore.setLastUnreadCount(inbox.localUnread);

      const nearFull = inbox.localMax > 0 && inbox.localInbox >= Math.floor(inbox.localMax * 0.92);
      if (nearFull && !this.stateStore.data.storageWarned) {
        this.stateStore.setStorageWarned(true);
        this.emit("storage_warning", {
          localInbox: inbox.localInbox,
          localMax: inbox.localMax,
          storageFull: inbox.localInbox >= inbox.localMax,
        });
      } else if (!nearFull && this.stateStore.data.storageWarned) {
        this.stateStore.setStorageWarned(false);
      }

      if (!this.stateStore.data.seeded && this.seedExistingOnStart) {
        const existingIndices = inbox.messages.map((m) => m.index);
        this.stateStore.completeSeed(existingIndices, inbox.localUnread);
        for (const m of inbox.messages) {
          this.archiveStore?.recordRealtimeMessage(m, "sms:updated");
        }
        this.emit("seeded", {
          seededCount: existingIndices.length,
          unreadMessages: inbox.localUnread,
          localInbox: inbox.localInbox,
          localMax: inbox.localMax,
        });
        return [];
      }

      if (!this.stateStore.data.seeded) {
        this.stateStore.completeSeed([], inbox.localUnread);
      }

      const knownMax =
        this.stateStore.data.notifiedIndices.length > 0
          ? Math.max(...this.stateStore.data.notifiedIndices)
          : 0;

      const freshMessages = inbox.messages
        .filter((m) => m.index > knownMax && !this.stateStore.isNotified(m.index))
        .sort((a, b) => a.index - b.index);

      if (freshMessages.length === 0) {
        return [];
      }

      const toMarkRead: number[] = [];
      for (const msg of freshMessages) {
        const enriched: SmsMessage = {
          ...msg,
          verificationCode: extractVerificationCode(msg.content),
        };
        this.stateStore.markNotified([msg.index]);
        this.archiveStore?.recordRealtimeMessage(enriched, "sms:new");
        this.emit("new_sms", enriched);
        if (this.webhookUrl) {
          this.#postWebhook(enriched).catch((err) => this.emit("error", err));
        }
        if (this.autoMarkRead && msg.isUnread) {
          toMarkRead.push(msg.index);
        }
      }

      if (toMarkRead.length > 0) {
        await this.cpeClient.markRead(toMarkRead);
        this.archiveStore?.markReadByCpeIndices(toMarkRead);
      }

      return freshMessages;
    } catch (err) {
      this.emit("error", err);
      return [];
    } finally {
      this.#syncing = false;
    }
  }

  async #postWebhook(sms: SmsMessage): Promise<void> {
    await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        event: "sms.received",
        timestamp: new Date().toISOString(),
        sms,
      }),
      signal: AbortSignal.timeout(10000),
    });
  }
}
