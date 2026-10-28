import { StorageCipher } from "./encrypted-file.ts";

const MAX_NOTIFIED_INDICES = 2000;
const MAX_REPLY_MAPPINGS = 500;

export interface StateStoreData {
  seeded: boolean;
  lastUnreadCount: number | null;
  storageWarned: boolean;
  authorizedChatIds: string[];
  notifiedIndices: number[];
  replyPhoneMap: Record<string, string>;
}

/**
 * Persistent state store for notified SMS cursor, paired Telegram chats,
 * and Telegram `message_id -> phone` reply routing, encrypted at rest via `StorageCipher`.
 */
export class StateStore {
  readonly filePath: string;
  readonly cipher: StorageCipher;
  data: StateStoreData;
  #notifiedSet: Set<number>;

  constructor(filePath: string, cipher: StorageCipher = StorageCipher.fromSecret()) {
    this.filePath = filePath;
    this.cipher = cipher;
    this.data = {
      seeded: false,
      lastUnreadCount: null,
      storageWarned: false,
      authorizedChatIds: [],
      notifiedIndices: [],
      replyPhoneMap: {},
    };
    this.#notifiedSet = new Set();
    this.load();
  }

  load(): void {
    try {
      const raw = this.cipher.readJsonFile<Partial<StateStoreData>>(this.filePath);
      if (!raw) return;
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
        raw.replyPhoneMap && typeof raw.replyPhoneMap === "object"
          ? { ...raw.replyPhoneMap }
          : {};
      this.#notifiedSet = new Set(this.data.notifiedIndices);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[StateStore] Failed to load ${this.filePath}, starting fresh: ${msg}`);
    }
  }

  save(): void {
    this.cipher.writeJsonFile(this.filePath, this.data);
  }

  isNotified(index: number): boolean {
    return this.#notifiedSet.has(index);
  }

  markNotified(indices: number[]): void {
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

  completeSeed(initialIndices: number[], unreadCount: number): void {
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

  setLastUnreadCount(count: number): void {
    if (this.data.lastUnreadCount !== count) {
      this.data.lastUnreadCount = count;
      this.save();
    }
  }

  setStorageWarned(warned: boolean): void {
    if (this.data.storageWarned !== warned) {
      this.data.storageWarned = warned;
      this.save();
    }
  }

  isChatAuthorized(chatId: string | number, envAllowedIds: string[] = []): boolean {
    const id = String(chatId);
    return envAllowedIds.includes(id) || this.data.authorizedChatIds.includes(id);
  }

  getAllAuthorizedChats(envAllowedIds: string[] = []): string[] {
    return [...new Set([...envAllowedIds.map(String), ...this.data.authorizedChatIds])];
  }

  authorizeChat(chatId: string | number): void {
    const id = String(chatId);
    if (!this.data.authorizedChatIds.includes(id)) {
      this.data.authorizedChatIds.push(id);
      this.save();
    }
  }

  bindReplyTarget(chatId: string | number, messageId: number, phone: string): void {
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

  getReplyTarget(chatId: string | number, messageId: number): string | null {
    return this.data.replyPhoneMap[`${chatId}:${messageId}`] ?? null;
  }
}
