#!/usr/bin/env node
import fs from "node:fs";
import type http from "node:http";
import { loadConfig } from "./config.ts";
import { ContactStore } from "./contacts.ts";
import { HuaweiCpeClient } from "./cpe-client.ts";
import { extractVerificationCode } from "./crypto.ts";
import { StorageCipher } from "./encrypted-file.ts";
import { createHttpApiServer, createWebProxyServer } from "./http-server.ts";
import { parseSenderInfo, resolveRecipientPhone } from "./phone.ts";
import { SmsPoller } from "./poller.ts";
import { SmsArchiveStore } from "./sms-archive.ts";
import { StateStore } from "./state-store.ts";
import { TelegramSmsBot } from "./telegram-bot.ts";
import type { AppConfig, SmsMessage } from "./types.ts";

function printHelp(): void {
  console.log(`
cpe-sms — 华为 5G CPE Ultra 6 (H168-383) 短信网关、Telegram 机器人与实时 Web 中心

用法:
  node dist/cli.js daemon                 启动完整服务（短信监听 + Telegram Bot + daisyUI 实时网页 + REST API）
  node dist/cli.js web                    仅启动独立 Web 前端代理服务（配合 docker compose --profile web 使用）
  node dist/cli.js sync                   立即拉取 CPE 全部历史短信到本地加密归档库 (data/sms-archive.json)
  node dist/cli.js import-vcf <file.vcf>  导入 iPhone / Mac 导出的 .vcf 通讯录文件到本地加密联系人库
  node dist/cli.js status                 查看 CPE 设备状态、5G 信号与短信容量
  node dist/cli.js inbox [count]          查看最近联系人短信会话列表（含国家区号与联系人识别）
  node dist/cli.js unread [count]         查看未读短信列表
  node dist/cli.js thread <phone>         查看与指定号码/服务号的完整短信对话
  node dist/cli.js send <phone> <text>    发送短信（支持默认爱尔兰 +353 本地号或任意 +国际号）
`);
}

async function runDaemon(config: AppConfig, cpeClient: HuaweiCpeClient): Promise<void> {
  const cipher = StorageCipher.fromSecret(config.dataEncryptionKey);
  const stateStore = new StateStore(config.stateFile, cipher);
  const contactStore = new ContactStore(config.contactsFile, config.defaultCountryCode, cipher);
  const archiveStore = new SmsArchiveStore({
    filePath: config.archiveFile,
    contactStore,
    defaultCountryCode: config.defaultCountryCode,
    cipher,
  });

  const poller = new SmsPoller({
    cpeClient,
    stateStore,
    archiveStore,
    pollIntervalMs: config.pollIntervalMs,
    fullSyncIntervalMs: config.fullSyncIntervalMs,
    seedExistingOnStart: config.seedExistingOnStart,
    autoMarkRead: config.autoMarkRead,
    webhookUrl: config.webhookUrl,
  });

  let bot: TelegramSmsBot | null = null;
  if (config.telegramToken) {
    bot = new TelegramSmsBot({
      token: config.telegramToken,
      apiBase: config.telegramApiBase,
      allowedChatIds: config.telegramChatIds,
      defaultCountryCode: config.defaultCountryCode,
      cpePassword: config.cpePassword,
      cpeClient,
      stateStore,
      contactStore,
      archiveStore,
      poller,
    });
  }

  poller.on(
    "seeded",
    (info: {
      seededCount: number;
      unreadMessages: number;
      localInbox: number;
      localMax: number;
    }) => {
      console.log(
        `[Poller] 初始历史加密归档与游标已完成：同步了 ${info.seededCount} 条历史短信（当前未读 ${info.unreadMessages} 条，容量 ${info.localInbox}/${info.localMax}），后续新短信将实时推送。`
      );
    }
  );

  poller.on("new_sms", (sms: SmsMessage) => {
    const sender = parseSenderInfo(sms.phone, sms.content, config.defaultCountryCode);
    const contact = contactStore.resolvePhone(sms.phone);
    const who = contact ? `${contact.name} (${sms.phone})` : `${sender.flag} ${sms.phone}`;
    const otpTag = sms.verificationCode ? ` [验证码: ${sms.verificationCode}]` : "";
    console.log(`[Poller] 收到新短信 #${sms.index} 来自 ${who} (${sms.date})${otpTag}`);
    if (bot) {
      bot.notifyNewSms(sms).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[TelegramBot] 推送失败:", msg);
      });
    }
  });

  poller.on(
    "storage_warning",
    (info: { localInbox: number; localMax: number; storageFull: boolean }) => {
      console.warn(`[Poller] 短信容量告警: ${info.localInbox}/${info.localMax}`);
      if (bot) {
        bot.notifyStorageWarning(info).catch(() => {});
      }
    }
  );

  poller.on("error", (err: Error) => {
    console.error(`[Poller] 轮询异常: ${err.message}`);
  });

  const servers: http.Server[] = [];

  if (config.webEnabled && config.webPort > 0) {
    const webServer = createHttpApiServer({
      cpeClient,
      poller,
      archiveStore,
      contactStore,
      apiToken: config.apiToken,
      defaultCountryCode: config.defaultCountryCode,
      serveWebUi: true,
    });
    await new Promise<void>((resolve, reject) => {
      webServer.once("error", reject);
      webServer.listen(config.webPort, config.webHost, () => resolve());
    });
    servers.push(webServer);
    console.log(
      `[WebUI] 🌼 daisyUI 实时短信网页与 REST API 已启动: http://${config.webHost}:${config.webPort}`
    );
  } else {
    console.log(`[WebUI] 实时网页已关闭 (WEB_ENABLED=false)`);
  }

  if (config.httpPort > 0 && (!config.webEnabled || config.httpPort !== config.webPort)) {
    const apiServer = createHttpApiServer({
      cpeClient,
      poller,
      archiveStore,
      contactStore,
      apiToken: config.apiToken,
      defaultCountryCode: config.defaultCountryCode,
      serveWebUi: false,
    });
    await new Promise<void>((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(config.httpPort, config.httpHost, () => resolve());
    });
    servers.push(apiServer);
    console.log(
      `[HTTP] 独立 REST API 已监听 http://${config.httpHost}:${config.httpPort} (GET /healthz)`
    );
  }

  if (bot) {
    await bot.start();
    const authChats = stateStore.getAllAuthorizedChats(config.telegramChatIds);
    console.log(
      `[Telegram] 机器人 @${bot.botInfo?.username ?? "bot"} 已启动！` +
        (authChats.length > 0
          ? `已授权会话: ${authChats.join(", ")}`
          : `尚未绑定会话 -> 请在 Telegram 向 @${bot.botInfo?.username ?? "bot"} 发送 "/auth <CPE密码>" 完成绑定`)
    );
  } else {
    console.warn("[Telegram] 未配置 TELEGRAM_API，仅运行轮询与 Web/API 服务。");
  }

  await poller.start();
  console.log(
    `[Daemon] 正在监控 CPE ${config.cpeUrl}（免登录轮询 ${config.pollIntervalMs}ms | 默认区号 ${config.defaultCountryCode} | AES-256-GCM 静态加密已启用 | 归档 ${archiveStore.messages.size} 条 | 通讯录 ${contactStore.contacts.length} 人）...`
  );

  const shutdown = (signal: string): void => {
    console.log(`\n[Daemon] 收到 ${signal}，正在安全退出...`);
    poller.stop();
    if (bot) bot.stop();
    let remaining = servers.length;
    if (remaining === 0) process.exit(0);
    for (const srv of servers) {
      srv.close(() => {
        remaining -= 1;
        if (remaining <= 0) process.exit(0);
      });
    }
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function runStandaloneWeb(config: AppConfig): Promise<void> {
  const port = config.webPort || 18383;
  const upstreamUrl =
    config.webUpstreamUrl || `http://127.0.0.1:${config.httpPort || 18383}`;
  const server = createWebProxyServer({ upstreamUrl });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, config.webHost, () => resolve());
  });
  console.log(
    `[WebUI-Proxy] 🌼 独立 daisyUI 网页服务已启动 http://${config.webHost}:${port} -> 上游 ${upstreamUrl}`
  );
  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = (args[0] ?? "daemon").toLowerCase();

  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    return;
  }

  const config = loadConfig();

  if (cmd === "web") {
    await runStandaloneWeb(config);
    return;
  }

  if (cmd === "import-vcf") {
    const filePath = args[1];
    if (!filePath || !fs.existsSync(filePath)) {
      console.error("用法: npm run cpe:import-vcf -- <contacts.vcf 文件路径>");
      process.exit(1);
    }
    const cipher = StorageCipher.fromSecret(config.dataEncryptionKey);
    const contactStore = new ContactStore(config.contactsFile, config.defaultCountryCode, cipher);
    const stats = contactStore.importVcard(fs.readFileSync(filePath, "utf8"));
    console.log(
      `✅ 通讯录加密导入成功：解析 ${stats.parsed} 条，新增 ${stats.added} 位，合并更新 ${stats.updated} 位（总计 ${stats.total} 位）`
    );
    return;
  }

  if (!config.cpePassword) {
    console.error("错误: 未检测到 CPE_PASSWORD，请检查 .env 文件配置。");
    process.exit(1);
  }

  const cipher = StorageCipher.fromSecret(config.dataEncryptionKey);
  const cpeClient = new HuaweiCpeClient(config);

  switch (cmd) {
    case "daemon":
    case "serve":
      await runDaemon(config, cpeClient);
      break;

    case "sync": {
      const contactStore = new ContactStore(config.contactsFile, config.defaultCountryCode, cipher);
      const archiveStore = new SmsArchiveStore({
        filePath: config.archiveFile,
        contactStore,
        defaultCountryCode: config.defaultCountryCode,
        cipher,
      });
      console.log("正在从 CPE 全量拉取收件箱与发件箱历史短信...");
      const dump = await cpeClient.fetchAllMessages();
      if (!dump) {
        console.error("未能获取 CPE 会话。");
        process.exit(1);
      }
      const summary = archiveStore.ingestFullDump(dump);
      console.log(
        `✅ 同步完成：CPE 当前共 ${dump.messages.length} 条（收件箱 ${dump.localInbox}，发件箱 ${dump.localOutbox}），本地 AES-256-GCM 加密归档库总计 ${summary.archiveTotal} 条。`
      );
      break;
    }

    case "status": {
      const s = await cpeClient.getStatusSummary();
      console.log(
        `设备型号 : ${s.device.marketingName || s.device.deviceName} (${s.device.deviceName})`
      );
      console.log(`后台地址 : ${config.cpeUrl}`);
      if (s.network?.operatorName || s.network?.numericPlmn) {
        console.log(`运营商   : ${s.network.operatorName || s.network.numericPlmn}`);
      }
      if (s.signal) {
        console.log(
          `信号指标 : 5G RSRP=${s.signal.nrRsrp || "-"} SINR=${s.signal.nrSinr || "-"} | 4G RSRP=${s.signal.rsrp || "-"} SINR=${s.signal.sinr || "-"}`
        );
      }
      if (s.sms) {
        console.log(
          `短信统计 : 未读 ${s.sms.localUnread} 条 | 收件箱 ${s.sms.localInbox}/${s.sms.localMax} | 发件箱 ${s.sms.localOutbox} | 联系人会话 ${s.sms.contactThreads}`
        );
      }
      break;
    }

    case "inbox": {
      const count = Number.parseInt(args[1] ?? "15", 10) || 15;
      const contactStore = new ContactStore(config.contactsFile, config.defaultCountryCode, cipher);
      const res = await cpeClient.listContacts({ page: 1, count });
      if (!res) break;
      console.log(`最近短信会话（展示 ${res.contacts.length} / 共 ${res.total} 个联系人）：\n`);
      for (const c of res.contacts) {
        const tag = c.isUnread ? "[未读]" : c.direction === "out" ? "[发出]" : "[已读]";
        const sender = parseSenderInfo(c.phone, c.content, config.defaultCountryCode);
        const contact = contactStore.resolvePhone(c.phone);
        const label = contact
          ? `${contact.name} (${sender.flag} ${sender.e164 ?? c.phone})`
          : `${sender.flag} ${sender.e164 ?? c.phone} (${sender.countryZh})`;
        console.log(`${tag} #${c.index} | ${label} | ${c.date}`);
        console.log(`  ${c.content.replace(/\s+/g, " ")}\n`);
      }
      break;
    }

    case "unread": {
      const count = Number.parseInt(args[1] ?? "15", 10) || 15;
      const contactStore = new ContactStore(config.contactsFile, config.defaultCountryCode, cipher);
      const res = await cpeClient.fetchRecentInboxMessages({ count, unreadOnly: true });
      if (!res) break;
      console.log(`未读短信（展示 ${res.messages.length} / 共 ${res.localUnread} 条）：\n`);
      for (const m of res.messages) {
        const otp = extractVerificationCode(m.content);
        const sender = parseSenderInfo(m.phone, m.content, config.defaultCountryCode);
        const contact = contactStore.resolvePhone(m.phone);
        const who = contact
          ? `${contact.name} (${m.phone})`
          : `${sender.flag} ${m.phone} (${sender.countryZh})`;
        console.log(`#${m.index} | ${who} | ${m.date}${otp ? ` | 验证码: ${otp}` : ""}`);
        console.log(`  ${m.content.replace(/\s+/g, " ")}\n`);
      }
      break;
    }

    case "thread":
    case "chat": {
      const phone = args[1];
      if (!phone) {
        console.error("用法: npm run cpe:thread -- <号码或发件人>");
        process.exit(1);
      }
      const res = await cpeClient.listPhoneMessages(phone, { page: 1, count: 20 });
      if (!res) break;
      console.log(`与 ${res.phone} 的对话记录（共 ${res.total} 条）：\n`);
      for (const m of res.messages) {
        const dir = m.direction === "out" ? "-> 我" : `<- ${res.phone}`;
        console.log(`[${m.date}] ${dir} (#${m.index}${m.isUnread ? " 未读" : ""}):`);
        console.log(`  ${m.content}\n`);
      }
      break;
    }

    case "send": {
      const rawPhone = args[1];
      const text = args.slice(2).join(" ");
      if (!rawPhone || !text) {
        console.error("用法: npm run cpe:send -- <接收号码> <短信内容>");
        process.exit(1);
      }
      const resolved = resolveRecipientPhone(rawPhone, config.defaultCountryCode);
      if (!resolved.ok) {
        console.error(`号码错误: ${resolved.error}`);
        process.exit(1);
      }
      console.log(`正在发送短信至 ${resolved.flag} ${resolved.phone} (${resolved.countryZh})...`);
      const res = await cpeClient.sendSms(resolved.phone, text);
      if (res.ok) {
        console.log(`✅ 发送成功！编码=${res.encoding}，分段=${res.segments} 条`);
      } else {
        console.error(
          `❌ 发送失败！失败号码=${res.failedPhones.join(",")} 错误码=${res.failCode ?? ""}`
        );
        process.exit(1);
      }
      break;
    }

    default:
      printHelp();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("运行失败:", msg);
  process.exit(1);
});
