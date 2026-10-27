import { EventEmitter } from "node:events";
import { extractVerificationCode } from "./crypto.js";

/**
 * Zero-conflict SMS poller:
 * 1. Polls unauthenticated `/api/monitoring/check-notifications` every `pollIntervalMs` (default 5s).
 * 2. Opens an ephemeral encrypted session ONLY when `UnreadMessage` changes or when `fullSyncIntervalMs`
 *    elapses while the WebUI is idle (`State != 0`), so browser access to `http://192.168.8.1/#/sms`
 *    is never interrupted.
 *
 * Emits:
 * - `"seeded"`: `{ seededCount, unreadMessages, localInbox, localMax }`
 * - `"new_sms"`: `message` (enriched with `verificationCode`)
 * - `"storage_warning"`: `{ localInbox, localMax, storageFull }`
 * - `"error"`: `Error`
 */
export class SmsPoller extends EventEmitter {
  /**
   * @param {{
   *   cpeClient: import("./cpe-client.js").HuaweiCpeClient,
   *   stateStore: import("./state-store.js").StateStore,
   *   pollIntervalMs?: number,
   *   fullSyncIntervalMs?: number,
   *   seedExistingOnStart?: boolean,
   *   autoMarkRead?: boolean,
   *   webhookUrl?: string,
   *   fetchImpl?: typeof fetch
   * }} opts
   */
  constructor(opts) {
    super();
    this.cpeClient = opts.cpeClient;
    this.stateStore = opts.stateStore;
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

  /** @type {ReturnType<typeof setTimeout> | null} */
  #timer;
  #running;
  #syncing;
  #lastFullSyncAt;

  async start() {
    if (this.#running) return;
    this.#running = true;
    await this.syncOnce({ isInitial: true });
    this.#scheduleNext();
  }

  stop() {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #scheduleNext() {
    if (!this.#running) return;
    this.#timer = setTimeout(async () => {
      await this.tick();
      this.#scheduleNext();
    }, this.pollIntervalMs);
  }

  /**
   * Single lightweight poll tick.
   */
  async tick() {
    if (this.#syncing) return;
    try {
      const notif = await this.cpeClient.checkNotifications();
      const prevUnread = this.stateStore.data.lastUnreadCount;
      const now = Date.now();

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

  /**
   * Perform an authenticated inbox sync to discover un-notified SMS messages.
   *
   * @param {{ isInitial?: boolean, respectBrowserSession?: boolean }} [opts]
   * @returns {Promise<Array<ReturnType<import("./cpe-client.js").parseSmsMessageBlock>>>}
   */
  async syncOnce(opts = {}) {
    if (this.#syncing) return [];
    this.#syncing = true;
    try {
      const inbox = await this.cpeClient.fetchRecentInboxMessages({
        count: 40,
        unreadOnly: false,
        respectBrowserSession: Boolean(opts.respectBrowserSession),
      });

      // Deferred politely because user's browser is actively logged in
      if (!inbox) {
        return [];
      }

      this.#lastFullSyncAt = Date.now();
      this.stateStore.setLastUnreadCount(inbox.localUnread);

      // Check SMS storage capacity warning (Huawei CPE stops receiving at 500/500!)
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

      // First boot seeding: record existing inbox indices without flooding notifications
      if (!this.stateStore.data.seeded && this.seedExistingOnStart) {
        const existingIndices = inbox.messages.map((m) => m.index);
        this.stateStore.completeSeed(existingIndices, inbox.localUnread);
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

      // If state was seeded earlier, only notify messages newer than the highest seeded index
      // OR not yet seen in `notifiedIndices`. Using `maxNotified` prevents old messages from
      // triggering if newer messages get deleted!
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

      const toMarkRead = [];
      for (const msg of freshMessages) {
        const enriched = {
          ...msg,
          verificationCode: extractVerificationCode(msg.content),
        };
        this.stateStore.markNotified([msg.index]);
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
      }

      return freshMessages;
    } catch (err) {
      this.emit("error", err);
      return [];
    } finally {
      this.#syncing = false;
    }
  }

  /**
   * @param {Record<string, unknown>} sms
   */
  async #postWebhook(sms) {
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
