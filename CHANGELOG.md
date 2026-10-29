# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-10-29

### Added
- **Huawei H168-383 Secure Protocol Engine**:
  - Full implementation of Huawei SCRAM-SHA256 authentication handshake with server signature verification.
  - Big-endian unclamped Curve25519 ECDH session key exchange and AES-256-GCM wire payload encryption (`enc-type=1|2|3`).
  - Strict circuit breaker on router error `108006` (invalid credentials) and `108007` (account locked) to prevent administrative lockouts.
  - Ephemeral authenticated sessions with automatic logout in `finally` blocks, preserving browser web portal accessibility.
- **StorageCipher At-Rest Encryption**:
  - Local state, SMS archive, and contact stores encrypted via `scrypt` master key derivation, per-write salt via `HKDF-SHA256`, and `AES-256-GCM` with atomic `0600` file permissions.
  - Seamless migration helper automatically upgrading legacy plaintext JSON records to encrypted format upon first write.
- **Sujian Minimal Real-Time Web Center**:
  - Web interface built on daisyUI v5 and Tailwind CSS v4, compiled offline with zero runtime CDN requirements.
  - Server-Sent Events (SSE) `/api/events` endpoint for instant inbound SMS delivery.
  - 4 foundational base themes (Light, Dark, Paper, Midnight) and 9 calibrated accent color options.
  - OTP identification with monospace highlight pill and one-click copy.
  - Consolidated single high-port architecture (`18383`) serving Web SPA, SSE stream, `/healthz`, and REST API endpoints.
- **Community-Contributable Localization (i18n)**:
  - Extensible locale architecture loaded from [`locales/*.json`](locales/) supporting runtime switching and browser language auto-detection.
  - Built-in Simplified Chinese (`zh-CN`) and English (`en`) translations with 100% key parity test coverage.
- **Interactive Telegram Bot**:
  - Multi-step guided send wizard (`/new`) with fuzzy contact lookup and real-time GSM 7-bit vs UCS-2 encoding calculation.
  - Native message reply routing allowing direct outgoing SMS dispatch by replying to notification cards.
  - iPhone / Mac vCard (`.vcf`) parsing and import via bot upload or CLI.
  - Command-based authorization flow (`/auth`) with in-memory brute-force rate limiting.
- **Quality Gates & Automated Verification**:
  - Comprehensive `node:test` suite maintaining >= 90% line and statement coverage and >= 95% function coverage.
  - Automated secret and private key audit scanner inspecting working tree, tracked files, and full git history.
  - Multi-architecture Docker container image publishing (`linux/amd64`, `linux/arm64`) to GitHub Container Registry (GHCR).

### Changed
- Unified default web service and API on port `18383` (configurable via `WEB_PORT`), disabling secondary HTTP port by default (`HTTP_PORT=0`).
- Replaced third-party HTTP and utility libraries with Node.js 22 built-in modules (`node:crypto`, `node:http`, `node:fs`, `fetch`), achieving zero production runtime dependencies.

---

## [1.0.0] - 2026-09-01

### Added
- Initial proof-of-concept SMS notification poller for Huawei CPE router.
- Basic Telegram notification webhook dispatch.
- Preliminary CLI diagnostic utilities for viewing message inbox and signal status.
