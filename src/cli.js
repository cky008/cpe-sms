#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { HuaweiCpeClient } from "./cpe-client.js";
import { extractVerificationCode } from "./crypto.js";
import { createHttpApiServer } from "./http-server.js";
import { SmsPoller } from "./poller.js";
import { StateStore } from "./state-store.js";
import { TelegramSmsBot } from "./telegram-bot.js";

function printHelp() {
  console.log(`
cpe-sms — 华为 5G CPE Ultra 6 (H168-383) 短信网关与 Telegram 机器人

用法:
  node src/cli.js daemon                 启动后台守护进程（短信实时监听 + Telegram Bot + HTTP API）
  node src/cli.js status                 查看 CPE 设备状态、5G 信号与短信容量
  node src/cli.js inbox [count]          查看最近联系人短信会话列表
  node src/cli.js unread [count]         查看未读短信列表
  node src/cli.js thread <phone>         查看与指定号码/服务号的完整短信对话
  node src/cli.js send <phone> <text>    发送短信并等待运营商回执状态
`);
}

async function runDaemon(config, cpeClient) {
  const stateStore = new StateStore(config.stateFile);
  const poller = new SmsPoller({
    cpeClient,
    stateStore,
    pollIntervalMs: config.pollIntervalMs,
    fullSyncIntervalMs: config.fullSyncIntervalMs,
    seedExistingOnStart: config.seedExistingOnStart,
    autoMarkRead: config.autoMarkRead,
    webhookUrl: config.webhookUrl,
  });

  /** @type {TelegramSmsBot | null} */
  let bot = null;
  if (config.telegramToken) {
    bot = new TelegramSmsBot({
      token: config.telegramToken,
      apiBase: config.telegramApiBase,
      allowedChatIds: config.telegramChatIds,
      cpePassword: config.cpePassword,
      cpeClient,
      stateStore,
      poller,
    });
  }

  poller.on("seeded", (info) => {
    console.log(
      `[Poller] 初始快照已完成：记录了最新 ${info.seededCount} 条历史短信游标（当前未读 ${info.unreadMessages} 条，容量 ${info.localInbox}/${info.localMax}），后续新短信将实时推送。`
    );
  });

  poller.on("new_sms", (sms) => {
    const otpTag = sms.verificationCode ? ` [验证码: ${sms.verificationCode}]` : "";
    console.log(`[Poller] 收到新短信 #${sms.index} 来自 ${sms.phone} (${sms.date})${otpTag}`);
    if (bot) {
      bot.notifyNewSms(sms).catch((err) => {
        console.error("[TelegramBot] 推送失败:", err.message);
      });
    }
  });

  poller.on("storage_warning", (info) => {
    console.warn(`[Poller] 短信容量告警: ${info.localInbox}/${info.localMax}`);
    if (bot) {
      bot.notifyStorageWarning(info).catch(() => {});
    }
  });

  poller.on("error", (err) => {
    console.error(`[Poller] 轮询异常: ${err.message}`);
  });

  /** @type {import("node:http").Server | null} */
  let httpServer = null;
  if (config.httpPort > 0) {
    httpServer = createHttpApiServer({
      cpeClient,
      poller,
      apiToken: config.apiToken,
    });
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(config.httpPort, config.httpHost, () => resolve(undefined));
    });
    console.log(`[HTTP] REST API 已监听 http://${config.httpHost}:${config.httpPort} (GET /healthz)`);
  }

  if (bot) {
    await bot.start();
    const authChats = stateStore.getAllAuthorizedChats(config.telegramChatIds);
    console.log(
      `[Telegram] 机器人 @${bot.botInfo?.username ?? "bot"} 已启动！` +
        (authChats.length > 0
          ? `已授权会话: ${authChats.join(", ")}`
          : `尚未绑定会话 -> 请在 Telegram 向 @${bot.botInfo?.username} 发送 "/auth <CPE密码>" 完成绑定`)
    );
  } else {
    console.warn("[Telegram] 未配置 TELEGRAM_API，仅运行轮询与 HTTP/Webhook 服务。");
  }

  await poller.start();
  console.log(
    `[Daemon] 正在监控 CPE ${config.cpeUrl}（免登录轮询间隔 ${config.pollIntervalMs}ms）...`
  );

  const shutdown = (signal) => {
    console.log(`\n[Daemon] 收到 ${signal}，正在安全退出...`);
    poller.stop();
    if (bot) bot.stop();
    if (httpServer) {
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    } else {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args[0] ?? "daemon").toLowerCase();

  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    return;
  }

  const config = loadConfig();
  if (!config.cpePassword) {
    console.error("错误: 未检测到 CPE_PASSWORD，请检查 .env 文件配置。");
    process.exit(1);
  }

  const cpeClient = new HuaweiCpeClient(config);

  switch (cmd) {
    case "daemon":
    case "serve":
      await runDaemon(config, cpeClient);
      break;

    case "status": {
      const s = await cpeClient.getStatusSummary();
      console.log(`设备型号 : ${s.device.marketingName || s.device.deviceName} (${s.device.deviceName})`);
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
      const res = await cpeClient.listContacts({ page: 1, count });
      console.log(`最近短信会话（展示 ${res.contacts.length} / 共 ${res.total} 个联系人）：\n`);
      for (const c of res.contacts) {
        const tag = c.isUnread ? "[未读]" : c.direction === "out" ? "[发出]" : "[已读]";
        console.log(`${tag} #${c.index} | ${c.phone} | ${c.date}`);
        console.log(`  ${c.content.replace(/\s+/g, " ")}\n`);
      }
      break;
    }

    case "unread": {
      const count = Number.parseInt(args[1] ?? "15", 10) || 15;
      const res = await cpeClient.fetchRecentInboxMessages({ count, unreadOnly: true });
      console.log(`未读短信（展示 ${res.messages.length} / 共 ${res.localUnread} 条）：\n`);
      for (const m of res.messages) {
        const otp = extractVerificationCode(m.content);
        console.log(`#${m.index} | ${m.phone} | ${m.date}${otp ? ` | 验证码: ${otp}` : ""}`);
        console.log(`  ${m.content.replace(/\s+/g, " ")}\n`);
      }
      break;
    }

    case "thread":
    case "chat": {
      const phone = args[1];
      if (!phone) {
        console.error("用法: node src/cli.js thread <号码或发件人>");
        process.exit(1);
      }
      const res = await cpeClient.listPhoneMessages(phone, { page: 1, count: 20 });
      console.log(`与 ${res.phone} 的对话记录（共 ${res.total} 条）：\n`);
      for (const m of res.messages) {
        const dir = m.direction === "out" ? "-> 我" : `<- ${res.phone}`;
        console.log(`[${m.date}] ${dir} (#${m.index}${m.isUnread ? " 未读" : ""}):`);
        console.log(`  ${m.content}\n`);
      }
      break;
    }

    case "send": {
      const phone = args[1];
      const text = args.slice(2).join(" ");
      if (!phone || !text) {
        console.error("用法: node src/cli.js send <接收号码> <短信内容>");
        process.exit(1);
      }
      console.log(`正在发送短信至 ${phone}...`);
      const res = await cpeClient.sendSms(phone, text);
      if (res.ok) {
        console.log(`✅ 发送成功！编码=${res.encoding}，分段=${res.segments} 条`);
      } else {
        console.error(`❌ 发送失败！失败号码=${res.failedPhones.join(",")} 错误码=${res.failCode}`);
        process.exit(1);
      }
      break;
    }

    default:
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("运行失败:", err.message);
  process.exit(1);
});
