export type SmsDirection = "in" | "out";
export type SmsEncodingName = "7BIT" | "UCS2";
export type SmsTextModeCode = 0 | 1;

export interface SmsModeDetection {
  textMode: SmsTextModeCode;
  encoding: SmsEncodingName;
  segments: number;
  charUnits: number;
}

export interface SmsMessage {
  index: number;
  phone: string;
  content: string;
  date: string;
  smstat: string;
  smstype: string;
  curbox: string;
  isUnread: boolean;
  direction: SmsDirection;
  verificationCode?: string | null;
}

export interface ArchivedSmsMessage extends SmsMessage {
  uid: string;
  verificationCode: string | null;
  onCpe: boolean;
}

export interface CountryDialInfo {
  code: string;
  iso: string;
  flag: string;
  nameZh: string;
  nameEn: string;
  dropTrunkZero: boolean;
}

export type SenderCategory =
  | "unknown"
  | "alphanumeric"
  | "gateway"
  | "shortcode"
  | "international"
  | "national"
  | "other";

export interface SenderInfo {
  type: SenderCategory;
  raw: string;
  e164: string | null;
  dialable: boolean;
  flag: string;
  countryCode: string | null;
  countryZh: string;
  countryIso: string | null;
  brandHint: string | null;
  displayNumber: string;
}

export type ResolvedRecipient =
  | {
      ok: true;
      phone: string;
      flag: string;
      countryCode: string | null;
      countryZh: string;
      isShortCode: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export interface ContactRecord {
  id: string;
  name: string;
  phones: string[];
  note?: string;
  source: "manual" | "vcard";
  updatedAt: string;
}

export interface ContactBrief {
  id: string;
  name: string;
  note?: string;
}

export interface EnrichedSmsMessage extends ArchivedSmsMessage {
  threadKey: string;
  sender: SenderInfo;
  contact: ContactBrief | null;
}

export interface ArchiveThread {
  threadKey: string;
  phone: string;
  replyPhone: string | null;
  dialable: boolean;
  sender: SenderInfo;
  contact: ContactBrief | null;
  displayName: string;
  unreadCount: number;
  totalCount: number;
  hasOtp: boolean;
  latestOtp: string | null;
  latestMessage: ArchivedSmsMessage;
  matchedPreview?: string;
}

export interface ThreadDetail {
  threadKey: string;
  phone: string;
  replyPhone: string | null;
  dialable: boolean;
  sender: SenderInfo;
  contact: ContactBrief | null;
  messages: EnrichedSmsMessage[];
}

export interface CpeArchiveStats {
  localUnread: number;
  localInbox: number;
  localOutbox: number;
  localMax: number;
}

export interface CpeFullDump extends CpeArchiveStats {
  messages: SmsMessage[];
}

export interface CpeStatusSummary {
  device: {
    deviceName: string;
    marketingName: string;
    classify: string;
  };
  sms?: {
    localUnread: number;
    localInbox: number;
    localOutbox: number;
    localDraft: number;
    localMax: number;
    contactThreads: number;
    storageFull: boolean;
  };
  signal?: {
    mode: string;
    rsrp: string;
    sinr: string;
    nrRsrp: string;
    nrSinr: string;
    band: string;
  };
  network?: {
    operatorName: string;
    numericPlmn: string;
    connectionStatus: string;
    currentNetworkTypeEx: string;
    signalIcon: string;
  };
}

export interface SendSmsResult {
  ok: boolean;
  submitted: boolean;
  timedOutWaitingStatus?: boolean;
  sentPhones: string[];
  failedPhones: string[];
  failCode: string | null;
  encoding: SmsEncodingName;
  segments: number;
}

export interface AppConfig {
  cpeUrl: string;
  cpeUsername: string;
  cpePassword: string;
  dataEncryptionKey: string;
  telegramToken: string;
  telegramApiBase: string;
  telegramChatIds: string[];
  defaultCountryCode: string;
  pollIntervalMs: number;
  fullSyncIntervalMs: number;
  requestTimeoutMs: number;
  seedExistingOnStart: boolean;
  autoMarkRead: boolean;
  stateFile: string;
  archiveFile: string;
  contactsFile: string;
  webEnabled: boolean;
  webPort: number;
  webHost: string;
  webUpstreamUrl: string;
  httpPort: number;
  httpHost: string;
  apiToken: string;
  webhookUrl: string;
}
