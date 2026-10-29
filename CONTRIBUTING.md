# Contributing to cpe-sms

Thank you for your interest in contributing to `cpe-sms`! This document provides guidelines for setting up your development environment, adhering to our Test-Driven Development (TDD) workflow, and submitting pull requests.

---

## 1. Prerequisites & Tech Stack

- **Runtime**: Node.js `>= 22.6.0` (Native ESM `"type": "module"`, 100% built-in `node:crypto`, `node:http`, `node:fs`, `fetch`).
- **Language**: Strict TypeScript (`typescript` 7.x) across backend (`src/*.ts`), browser SPA (`src/web/client/app.ts`), and tests (`test/*.test.ts`).
- **Dependencies**: **Zero production runtime dependencies**. Only dev dependencies (`@tailwindcss/cli`, `daisyui`, `c8`, `typescript`) are permitted for build and test.

---

## 2. Development Setup

```bash
# 1. Clone your fork
git clone https://github.com/<your-username>/cpe-sms.git
cd cpe-sms

# 2. Install development dependencies
npm install

# 3. Build web assets and backend TypeScript
npm run build

# 4. Verify quality gates
npm run check
```

---

## 3. Test-Driven Development (TDD) Workflow

Every feature, bug fix, or protocol adjustment **must** follow strict Red-Green-Refactor TDD:

1. **Red**: Write a failing test in `test/*.test.ts` using Node's native runner (`node:test`) and `node:assert/strict`.
   - **CRITICAL**: Never send requests to real LAN hardware (`192.168.8.1`) or real external services (`api.telegram.org`) in automated tests. Always inject a mocked `fetchImpl` or bind to an ephemeral local server (`127.0.0.1:0`).
2. **Green**: Write the minimal, strictly-typed implementation in `src/*.ts` to pass the test.
3. **Refactor & Verify**: Clean up code and run the mandatory quality gate:
   ```bash
   npm run build
   npm run check
   ```

---

## 4. Quality Gates (`npm run check`)

All three checks are enforced in local pre-commit and GitHub Actions CI:

1. **Strict Typecheck (`npm run typecheck`)**:
   - `tsc -p tsconfig.test.json` (Backend + tests + scripts).
   - `tsc -p tsconfig.web.json --noEmit` (Browser DOM client).
2. **Test Coverage (`npm run test:coverage`)**:
   - Minimum global thresholds: **`>= 90%` lines, `>= 90%` statements, `>= 95%` functions**.
3. **Secret & Key Leak Scanner (`npm run audit:secrets`)**:
   - Validates that `.env`, `data/*` (except empty `data/.gitkeep`), and `*.vcf` are untracked.
   - Scans all files and the full `git log -p --all` history for high-risk tokens, PEM private keys, or passwords.

---

## 5. Coding Standards

- **TypeScript Strictness**: Keep `"strict": true`, `"verbatimModuleSyntax": true`, and `"rewriteRelativeImportExtensions": true` enabled. Use `import type { ... }` for type-only imports and explicit `.ts` extensions in relative imports.
- **Constant-Time Cryptography**: Use `crypto.timingSafeEqual` over SHA-256 digests for all token and password comparisons.
- **Zero Decorative Emojis**: The Web UI and Telegram Bot follow the Sujian (素笺) design language — clean typography, custom SVG icon sprites, and no decorative emojis.

---

## 6. Commit Message & Pull Request Conventions

- Follow **Conventional Commits**:
  - `feat(<scope>): <short summary>`
  - `fix(<scope>): <short summary>`
  - `security(<scope>): <short summary>`
  - `test(<scope>): <short summary>`
  - `refactor(<scope>): <short summary>`
  - `docs(<scope>): <short summary>`
  - `chore(<scope>): <short summary>`
- Before submitting a Pull Request:
  - Ensure all local commits pass `npm run build && npm run check`.
  - Never commit personal phone numbers, domains, or credentials.
