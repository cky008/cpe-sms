import fs from "node:fs";
import path from "node:path";

const MAX_NOTIFIED_INDICES = 2000;
const MAX_REPLY_MAPPINGS = 500;

/**
 * Persistent state store for notified SMS cursor, paired Telegram chats,
 * and Telegram `message_id -> phone` reply routing.
 */
export class StateStore {
  /**
   * @param {string} filePath
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      seeded: false,
      lastUnreadCount: null,
      storageWarned: false,
      /** @type {string[]} */
      authorizedChatIds: [],
      /** @type {number[]} */
      notifiedIndices: [],
      /** @type {Record<string, string>} key = `${chatId}:${messageId}`, value = phone */
      replyPhoneMap: {},
    };
    this.#notifiedSet = new Set();
    this.load();
  }

  /** @type {Set<number>} */
  #notifiedSet;

  load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.data.seeded = Boolean(raw.seeded);
      this.data.lastUnreadCount =
        typeof raw.lastUnreadCount === "number" ? raw.lastUnreadCount : null;
      this.data.storageWarned = Boolean(raw.storageWarned);
      this.data.authorizedChatIds = Array.isArray(raw.authorizedChatIds)
        ? raw.authorizedChatIds.map(String)
        : [];
      this.data.notifiedIndices = Array.isArray(raw.notifiedIndices)
        ? raw.notifiedIndices.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : [];
      this.data.replyPhoneMap =
        raw.replyPhoneMap && typeof raw.replyPhoneMap === "object" ? raw.replyPhoneMap : {};
      this.#notifiedSet = new Set(this.data.notifiedIndices);
    } catch (err) {
      console.warn(`[StateStore] Failed to parse ${this.filePath}, starting fresh:`, err.message);
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpFile = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(this.data, null, 2);
    fs.writeFileSync(tmpFile, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpFile, this.filePath);
  }

  /**
   * @param {number} index
   * @returns {boolean}
   */
  isNotified(index) {
    return this.#notifiedSet.has(index);
  }

  /**
   * Record SMS indices as notified and persist atomically.
   *
   * @param {number[]} indices
   */
  markNotified(indices) {
    let changed = false;
    for (const idx of indices) {
      if (!idx || this.#notifiedSet.has(idx)) continue;
      this.#notifiedSet.add(idx);
      this.data.notifiedIndices.push(idx);
      changed = true;
    }
    if (this.data.notifiedIndices.length > MAX_NOTIFIED_INDICES) {
      const excess = this.data.notifiedIndices.length - MAX_NOTIFIED_INDICES;
      const removed = this.data.notifiedIndices.splice(0, excess);
      for (const r of removed) this.#notifiedSet.delete(r);
      changed = true;
    }
    if (changed) this.save();
  }

  /**
   * Mark initial seeding complete.
   *
   * @param {number[]} initialIndices
   * @param {number} unreadCount
   */
  completeSeed(initialIndices, unreadCount) {
    for (const idx of initialIndices) {
      if (idx && !this.#notifiedSet.has(idx)) {
        this.#notifiedSet.add(idx);
        this.data.notifiedIndices.push(idx);
      }
    }
    if (this.data.notifiedIndices.length > MAX_NOTIFIED_INDICES) {
      this.data.notifiedIndices = this.data.notifiedIndices.slice(-MAX_NOTIFIED_INDICES);
      this.#notifiedSet = new Set(this.data.notifiedIndices);
    }
    this.data.seeded = true;
    this.data.lastUnreadCount = unreadCount;
    this.save();
  }

  /**
   * @param {number} count
   */
  setLastUnreadCount(count) {
    if (this.data.lastUnreadCount !== count) {
      this.data.lastUnreadCount = count;
      this.save();
    }
  }

  /**
   * @param {boolean} warned
   */
  setStorageWarned(warned) {
    if (this.data.storageWarned !== warned) {
      this.data.storageWarned = warned;
      this.save();
    }
  }

  /**
   * @param {string | number} chatId
   * @param {string[]} envAllowedIds
   */
  isChatAuthorized(chatId, envAllowedIds = []) {
    const id = String(chatId);
    return envAllowedIds.includes(id) || this.data.authorizedChatIds.includes(id);
  }

  /**
   * @param {string[]} envAllowedIds
   * @returns {string[]}
   */
  getAllAuthorizedChats(envAllowedIds = []) {
    return [...new Set([...envAllowedIds.map(String), ...this.data.authorizedChatIds])];
  }

  /**
   * Authorize and persist a Telegram chat ID.
   *
   * @param {string | number} chatId
   */
  authorizeChat(chatId) {
    const id = String(chatId);
    if (!this.data.authorizedChatIds.includes(id)) {
      this.data.authorizedChatIds.push(id);
      this.save();
    }
  }

  /**
   * Bind a sent Telegram message to an SMS phone number so native Reply-to-Message works.
   *
   * @param {string | number} chatId
   * @param {number} messageId
   * @param {string} phone
   */
  bindReplyTarget(chatId, messageId, phone) {
    if (!phone) return;
    const key = `${chatId}:${messageId}`;
    this.data.replyPhoneMap[key] = phone;
    const keys = Object.keys(this.data.replyPhoneMap);
    if (keys.length > MAX_REPLY_MAPPINGS) {
      for (const oldKey of keys.slice(0, keys.length - MAX_REPLY_MAPPINGS)) {
        delete this.data.replyPhoneMap[oldKey];
      }
    }
    this.save();
  }

  /**
   * Look up which SMS phone number a Telegram message refers to.
   *
   * @param {string | number} chatId
   * @param {number} messageId
   * @returns {string | null}
   */
  getReplyTarget(chatId, messageId) {
    return this.data.replyPhoneMap[`${chatId}:${messageId}`] ?? null;
  }
}
