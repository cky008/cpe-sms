import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContactStore } from "../src/contacts.ts";
import { createHttpApiServer } from "../src/http-server.ts";
import { SmsArchiveStore } from "../src/sms-archive.ts";

/**
 * Pure in-memory / temporary demo server with 100% synthetic mock data.
 * Zero private information, zero real credentials, zero access to production .env or data/.
 */
function runDemoServer(): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-sms-demo-"));
  const contactsFile = path.join(tmpDir, "contacts.json");
  const archiveFile = path.join(tmpDir, "sms-archive.json");

  const contactStore = new ContactStore(contactsFile, "+353");
  contactStore.upsertManualContact({ phone: "+353831234567", name: "Alice Murphy" });
  contactStore.upsertManualContact({ phone: "+8613800138000", name: "Bob Chen" });
  contactStore.upsertManualContact({ phone: "+353875551234", name: "Sean Kelly" });

  const archiveStore = new SmsArchiveStore({
    filePath: archiveFile,
    contactStore,
    defaultCountryCode: "+353",
  });

  archiveStore.ingestFullDump({
    localUnread: 1,
    localInbox: 18,
    localOutbox: 6,
    localMax: 500,
    messages: [
      {
        index: 50001,
        phone: "Revolut",
        content: "Your Revolut security code is: 492018. Never share this code with anyone.",
        date: "2026-10-29 14:20:00",
        smstat: "0",
        smstype: "1",
        curbox: "0",
        isUnread: true,
        direction: "in",
      },
      {
        index: 50002,
        phone: "Revolut",
        content: "Payment of €14.50 to Dublin Coffee Roasters approved.",
        date: "2026-10-28 10:15:00",
        smstat: "1",
        smstype: "1",
        curbox: "0",
        isUnread: false,
        direction: "in",
      },
      {
        index: 50003,
        phone: "+353831234567",
        content: "Hey! Are you free this weekend for coffee in town?",
        date: "2026-10-29 11:30:00",
        smstat: "1",
        smstype: "1",
        curbox: "0",
        isUnread: false,
        direction: "in",
      },
      {
        index: 50004,
        phone: "+353831234567",
        content: "Hi Alice! Yes, sounds great. How about Saturday at 2pm?",
        date: "2026-10-29 11:32:00",
        smstat: "3",
        smstype: "1",
        curbox: "1",
        isUnread: false,
        direction: "out",
      },
      {
        index: 50005,
        phone: "+353831234567",
        content: "Perfect, see you then at 2pm!",
        date: "2026-10-29 11:33:00",
        smstat: "1",
        smstype: "1",
        curbox: "0",
        isUnread: false,
        direction: "in",
      },
      {
        index: 50006,
        phone: "Three",
        content: "Your monthly 5G broadband bundle has been renewed. Thank you for choosing Three.",
        date: "2026-10-25 09:00:00",
        smstat: "1",
        smstype: "1",
        curbox: "0",
        isUnread: false,
        direction: "in",
      },
      {
        index: 50007,
        phone: "Google",
        content: "G-839201 is your Google verification code.",
        date: "2026-10-24 16:45:00",
        smstat: "1",
        smstype: "1",
        curbox: "0",
        isUnread: false,
        direction: "in",
      },
      {
        index: 50008,
        phone: "+353879876543",
        content: "An Post Express: Your parcel #IE928374 will arrive today between 13:00 - 15:00.",
        date: "2026-10-23 08:30:00",
        smstat: "1",
        smstype: "1",
        curbox: "0",
        isUnread: false,
        direction: "in",
      },
    ],
  });

  const fakeCpe = {
    async getStatusSummary() {
      return {
        device: {
          deviceName: "H168-383",
          marketingName: "Huawei 5G CPE Ultra 6",
          classify: "cpe",
        },
        network: {
          operatorName: "Three Ireland",
          numericPlmn: "27205",
          connectionStatus: "901",
          currentNetworkTypeEx: "5G",
          signalIcon: "5",
        },
        signal: {
          mode: "5G",
          rsrp: "-88dBm",
          sinr: "17dB",
          nrRsrp: "-86dBm",
          nrSinr: "22dB",
          band: "N78",
        },
        sms: {
          localUnread: 1,
          localInbox: 18,
          localOutbox: 6,
          localDraft: 0,
          localMax: 500,
          contactThreads: 5,
          storageFull: false,
        },
      };
    },
    async sendSms(phones: string[], content: string) {
      archiveStore.recordRealtimeMessage({
        phone: phones[0] ?? "",
        content,
        date: new Date().toISOString().replace("T", " ").slice(0, 19),
        direction: "out",
      });
      return {
        ok: true,
        submitted: true,
        sentPhones: phones,
        failedPhones: [],
        failCode: null,
        encoding: "7BIT" as const,
        segments: 1,
      };
    },
    async deleteSms() {
      return { count: 1 };
    },
  };

  const port = Number.parseInt(process.env.DEMO_PORT ?? "18383", 10) || 18383;
  const demoPassword = process.env.DEMO_PASSWORD ?? "demo";

  const server = createHttpApiServer({
    cpeClient: fakeCpe as never,
    archiveStore,
    contactStore,
    apiToken: demoPassword,
    defaultCountryCode: "+353",
    serveWebUi: true,
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`
========================================================================
🌿 cpe-sms 素笺 (Sujian) 演示服务已启动！
------------------------------------------------------------------------
• 浏览器访问 : http://127.0.0.1:${port}
• 演示密码   : ${demoPassword}
• 数据环境   : 100% 内存虚拟测试数据（零隐私信息、无真实凭据）
• 功能支持   : 
  - 登录页与主工作台实机展示
  - 4 套基底主题（晴昼 / 宣纸 / 墨夜 / 深黛）平滑切换
  - 9 种强调色切换
  - 验证码胶囊一键复制与分段计费预览
  - 模拟回复与搜索
------------------------------------------------------------------------
截图完成后，按 Ctrl+C 即可终止服务并自动清理临时缓存目录。
========================================================================
`);
  });

  const cleanup = (): void => {
    console.log("\n正在停止演示服务并清理临时缓存...");
    server.close(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
      process.exit(0);
    });
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

runDemoServer();
