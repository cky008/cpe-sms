# AGENTS.md — Engineering, TDD & Security Specification

This document defines the mandatory architecture, coding standards, Test-Driven Development (TDD) workflow, protocol invariants, and zero-leakage security rules for all AI coding agents and human contributors working on `cpe-sms`.

---

## 1. Project Overview & Tech Stack

- **Purpose**: End-to-end encrypted SMS gateway, Telegram Bot (with guided send wizard), historical SMS archive, and real-time `daisyUI` Web Center for **Huawei 5G CPE Ultra 6 (`H168-383`)**, designed for NAS (Synology DSM / Docker) + Tailscale private mesh networks.
- **Language**: **Strict TypeScript (`typescript` 7.x)** across backend (`src/*.ts`), browser client (`src/web/client/app.ts`), build/audit scripts (`scripts/*.ts`), and tests (`test/*.test.ts`).
- **Runtime**: **Node.js `>= 22.6.0`** (ESM `"type": "module"`, zero runtime `dependencies` — 100% Node built-in `node:crypto`, `node:http`, `node:fs`, `fetch`).
- **Frontend Styling**: `daisyui` v5 + `tailwindcss` v4 compiled offline into `src/web/public/app.css` (zero external CDN requests).

---

## 2. Directory & Module Architecture

```text
cpe-sms/
├── src/
│   ├── types.ts            # Shared domain interfaces & strict union types
│   ├── config.ts           # Pure .env parser & strongly-typed AppConfig loader
│   ├── crypto.ts           # Curve25519 (unclamped BE), Huawei SCRAM-SHA256, CPE AES-256-GCM, OTP & GSM-7bit/UCS2
│   ├── encrypted-file.ts   # StorageCipher: scrypt + HKDF-SHA256 + AES-256-GCM at-rest file encryption
│   ├── xml.ts              # XML parser, Huawei XSS entity encoder/decoder, date helpers
│   ├── phone.ts            # 54-country dial code directory, E.164 normalization (+353 default), sender classifier
│   ├── state-store.ts      # Encrypted bot auth, reply-target bindings & dedup index store (data/state.json)
│   ├── contacts.ts         # Encrypted local contact book & Apple iPhone .vcf parser (data/contacts.json)
│   ├── sms-archive.ts      # Encrypted full historical SMS archive & SSE EventEmitter (data/sms-archive.json)
│   ├── cpe-client.ts       # Stateless ephemeral Huawei H168-383 client with automatic logout & 108006 circuit breaker
│   ├── poller.ts           # Zero-conflict unauthenticated notification poller + idle sync scheduler
│   ├── http-server.ts      # Unified daisyUI Web Server, SSE (/api/events), Cookie/Bearer REST API & reverse-proxy support
│   ├── telegram-bot.ts     # Guided Send Wizard, inline keyboards, reply-to-send, .vcf import & /auth rate limiter
│   ├── cli.ts              # CLI entrypoint (`daemon`, `web`, `sync`, `import-vcf`, `status`, `inbox`, `thread`, `send`)
│   ├── index.ts            # Public library barrel exports
│   └── web/
│       ├── styles.css      # Tailwind v4 + daisyUI v5 theme source
│       ├── client/app.ts   # Browser SPA client (strict DOM TypeScript -> emits src/web/public/app.js)
│       └── public/         # Static assets copied into dist/web/public during build
├── scripts/
│   ├── copy-web-assets.ts  # Copies compiled web assets into dist/web/public
│   └── audit-secrets.ts    # Automated working-tree & full git-history secret / private-key leak scanner
└── test/                   # Node native test runner (`node:test`) suites
```

---

## 3. Mandatory TDD (Red-Green-Refactor) Workflow

Every new feature, bug fix, or protocol adjustment **MUST** follow strict Test-Driven Development:

1. **Red**: Write a failing unit or integration test in `test/*.test.ts` using `node:test` and `node:assert/strict` that specifies the exact expected behavior, edge cases, and failure modes. Never hit real LAN devices (`192.168.8.1`) or real external APIs (`api.telegram.org`) inside automated tests — inject a mock `fetchImpl` or local ephemeral `127.0.0.1:0` server.
2. **Green**: Implement the minimal, clean, strictly-typed code in `src/*.ts` required to make the new test pass.
3. **Refactor & Verify**: Clean up duplication, verify types, build artifacts, and run the full quality gate:

```bash
npm run build
npm run check
```

### Enforced Quality Gates (`npm run check`)
All three gates must pass with exit code `0` before any commit:
1. **`npm run typecheck`**: Zero errors in both `tsconfig.test.json` (Node backend + tests + scripts) and `tsconfig.web.json` (DOM frontend).
2. **`npm run test:coverage`**: Enforced via `c8` with minimum global thresholds of **`>= 90%` lines, `>= 90%` statements, and `>= 95%` functions**.
3. **`npm run audit:secrets`**: Scans `git ls-files`, working tree, and full `git log -p --all` history for leaked credentials, tokens, or private keys.

---

## 4. Strict TypeScript Conventions

- Keep `"strict": true`, `"noImplicitAny": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`, `"erasableSyntaxOnly": true`, `"verbatimModuleSyntax": true`, and `"rewriteRelativeImportExtensions": true` enabled.
- Use `import type { ... }` for type-only imports (`verbatimModuleSyntax`).
- Use explicit `.ts` extensions in relative imports inside `src/*.ts` (`tsc` automatically rewrites them to `.js` when emitting to `dist/`).
- Avoid `any`; narrow `unknown` values (such as `fetch().then(r => r.json())` or `catch (err)`) explicitly.

---

## 5. Security, Encryption & Zero-Leakage Invariants

1. **Encryption at Rest (`StorageCipher`)**:
   - **NEVER** write plaintext SMS content, phone numbers, vCard contacts, or authorized Telegram Chat IDs to disk.
   - All persistent stores (`StateStore`, `ContactStore`, `SmsArchiveStore`) **MUST** serialize through [`StorageCipher`](src/encrypted-file.ts), which derives a 256-bit master key via `crypto.scryptSync` from `DATA_ENCRYPTION_KEY` (defaulting to `CPE_PASSWORD`), derives a unique per-write subkey via `crypto.hkdfSync("sha256", ...)` with a fresh 16-byte random salt, encrypts with `aes-256-gcm` using a fresh 12-byte random IV, and writes atomically (`0600` file mode).
2. **Encryption in Transit**:
   - **NAS <-> CPE**: Authenticate with Huawei SCRAM-SHA256, verify the router's RSA-PSS signature on `/api/webserver/eeccpubkey`, derive session keys via Curve25519 ECDH + HKDF-SHA256, and encrypt sensitive payloads (`sms-list-contact`, `sms-list-phone`, `send-sms`, `set-read`, `delete-sms`) with `aes-256-gcm` (`enc-type: 1|2|3`).
   - **Browser <-> Reverse Proxy <-> NAS**: Honor `X-Forwarded-Proto: https` by setting `Secure; HttpOnly; SameSite=Strict` session cookies, emit `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and set `X-Accel-Buffering: no` on `/api/events` so Nginx / Synology Reverse Proxy streams SSE immediately.
   - Compare all passwords and tokens in constant time (`crypto.timingSafeEqual` over SHA-256 digests) and enforce brute-force rate limits on both `/api/auth/login` and Telegram `/auth`.
3. **Zero-Secret Git Hygiene**:
   - **NEVER** commit `.env`, `data/`, `*.vcf`, `.pem`/`.key` files, real passwords, Telegram Bot tokens, or personal phone numbers/domains/IPs into source code, tests, or commit messages.
   - Use RFC-compliant example fixtures in tests and docs (`example.com`, `192.168.8.1`, `100.64.0.x`, `+353831234567`, `123456:FAKE_TOKEN`).

---

## 6. Huawei H168-383 Protocol Safety Rules

- **Circuit Breaker on `108006` / `108007`**: Never auto-retry when CPE returns `108006` (wrong password) or `108007` (account locked), as 3 consecutive failures lock out the CPE admin account on firmware `H168-383`.
- **Ephemeral Sessions Only**: Every authenticated CPE operation must run inside `withSession()` and execute `/api/user/logout` inside `finally`, keeping session hold times ~200ms so browser access to `http://192.168.8.1/#/sms` is never blocked.
- **Unauthenticated Polling**: Poll `/api/monitoring/check-notifications` without logging in; when `respectBrowserSession: true`, check `/api/user/state-login` first and yield if `State !== "-1"`.

---

## 7. NAS Deployment & Git Commit Standards

- **Single High Port Default (`18383`)**: Keep `WEB_PORT=18383` and `HTTP_PORT=0` by default in `src/config.ts` and `docker-compose.yml` so NAS port `8080` is never claimed unless explicitly configured.
- **Synology Volume Ownership**: Keep `docker-entrypoint.sh` (`chown -R node:node /app/data && chmod 700 /app/data && exec su-exec node "$@"`) so bind-mounted `./data` directories created by `sudo docker compose` work without `EACCES` while running Node unprivileged as `node`.
- **Conventional Commits**: Format all commit messages as `<type>(<scope>): <concise summary>` (`feat`, `fix`, `refactor`, `security`, `test`, `docs`, `chore`). Always run `npm run build && npm run check` prior to committing.
