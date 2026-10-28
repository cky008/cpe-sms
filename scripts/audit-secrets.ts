import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";

/**
 * Automated repository & git-history secret / private-key leak scanner.
 * Fails with exit code 1 if any real credential, PEM private key, Telegram Bot token,
 * or unencrypted runtime data file is tracked or present in tracked sources.
 */
const HIGH_RISK_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "PEM Private Key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  {
    name: "Real Telegram Bot Token",
    // Exclude documented placeholder `1234567890:AAExampleBotTokenFromBotFather` and test `123456:FAKE_TOKEN`
    regex: /\b\d{8,11}:AA[A-Za-z0-9_-]{30,}\b/,
  },
  { name: "GitHub Personal Access Token", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "AWS Access Key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
];

const ALLOWED_PLACEHOLDERS = new Set([
  "1234567890:AAExampleBotTokenFromBotFather",
]);

function scanText(label: string, content: string, dynamicSecrets: string[]): string[] {
  const issues: string[] = [];

  for (const sec of dynamicSecrets) {
    if (content.includes(sec)) {
      issues.push(`${label}: contains literal secret from local .env`);
    }
  }

  for (const pat of HIGH_RISK_PATTERNS) {
    const matches = content.match(new RegExp(pat.regex.source, "g")) ?? [];
    for (const m of matches) {
      if (!ALLOWED_PLACEHOLDERS.has(m)) {
        issues.push(`${label}: matched ${pat.name}`);
      }
    }
  }

  return issues;
}

function main(): void {
  const root = process.cwd();
  const cfg = loadConfig({ envPath: path.join(root, ".env") });
  const dynamicSecrets = Array.from(
    new Set(
      [cfg.cpePassword, cfg.telegramToken, cfg.apiToken, cfg.dataEncryptionKey].filter(
        (s) => Boolean(s) && s.length >= 5
      )
    )
  );

  // 1. Verify `.env` and `data/` are NOT tracked by git
  const trackedFiles = execSync("git ls-files", { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);

  const forbiddenTracked = trackedFiles.filter(
    (f) => f === ".env" || f.startsWith("data/") || f.endsWith(".vcf") || f.endsWith(".pem")
  );
  if (forbiddenTracked.length > 0) {
    console.error("❌ Forbidden sensitive files are tracked in git:", forbiddenTracked);
    process.exit(1);
  }

  // 2. Scan all working-tree files (excluding ignored `.git`, `node_modules`, `dist`, `data`, `.env`)
  const findings: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "data", ".env", "coverage"].includes(ent.name)) {
        continue;
      }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const text = fs.readFileSync(full, "utf8");
        findings.push(...scanText(path.relative(root, full), text, dynamicSecrets));
      }
    }
  };
  walk(root);

  // 3. Scan full git commit history
  const gitHistory = execSync("git log -p --all", {
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  findings.push(...scanText("git-history", gitHistory, dynamicSecrets));

  if (findings.length > 0) {
    console.error("❌ Secret / Private-Key Audit Failed:");
    for (const f of findings) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(
    `✅ Secret & Private-Key Audit Passed (${trackedFiles.length} tracked files + full git history clean).`
  );
}

main();
