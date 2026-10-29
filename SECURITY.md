# Security Policy

## Supported Versions

Only the latest major version receives security updates and vulnerability fixes:

| Version | Supported          |
| :------ | :----------------- |
| `2.x`   | :white_check_mark: |
| `< 2.0` | :x:                |

---

## Security Architecture & Invariants

`cpe-sms` is designed from the ground up for high-security home gateway and private mesh network environments (NAS + Tailscale). The core architecture enforces the following invariants:

1. **Zero-Plaintext Storage at Rest (`StorageCipher`)**:
   - SMS messages, one-time passwords (OTP), contact phone numbers, and Telegram chat authorizations are encrypted before touching disk.
   - Keys are derived via `scrypt` from `DATA_ENCRYPTION_KEY` (defaulting to `CPE_PASSWORD`), combined with random salts via `HKDF-SHA256`, and encrypted using `AES-256-GCM` with atomic `0600` file permissions.
2. **Router Protocol Safety (`HuaweiCpeClient`)**:
   - Router authentication uses SCRAM-SHA256 and validates the router's RSA-PSS ECC pubkey signature.
   - Sensitive router payloads are encrypted with Curve25519 ECDH + AES-256-GCM.
   - **`108006` Circuit Breaker**: The client immediately terminates upon receiving `108006` (wrong password) or `108007` (account locked) to prevent brute-force router lockouts.
   - **Ephemeral Sessions**: Authenticated router sessions are held for ~200ms and immediately terminated via `/api/user/logout` in a `finally` block to prevent blocking administrator browser access.
3. **Web & Reverse Proxy Hardening (`HttpServer`)**:
   - All passwords and tokens are compared using constant-time evaluation (`crypto.timingSafeEqual` over SHA-256 digests).
   - In-memory rate limiters mitigate brute-force attempts on `/api/auth/login` and Telegram `/auth`.
   - Origin and Referer validation protects state-changing endpoints against CSRF.
   - Strict cookie security (`HttpOnly`, `SameSite=Strict`, `Secure` behind HTTPS reverse proxies).
   - Client IP resolution rejects spoofed `X-Forwarded-For` headers from untrusted connections.

---

## Reporting a Vulnerability

If you discover a security vulnerability or potential credential leak in `cpe-sms`, please do **NOT** open a public GitHub Issue, Discussion, or Pull Request.

Instead, please report it responsibly:

1. **GitHub Advisory (Preferred)**:
   Submit a private advisory via GitHub:
   [https://github.com/cky008/cpe-sms/security/advisories/new](https://github.com/cky008/cpe-sms/security/advisories/new)
2. **Alternative**:
   Contact the repository maintainer directly via GitHub profile details.

### What to Include

Please provide as much detail as possible to help us verify and reproduce the issue:
- Description of the vulnerability and its potential impact.
- Affected component (`cpe-client`, `encrypted-file`, `http-server`, `telegram-bot`, etc.).
- Minimal reproduction steps or proof-of-concept (PoC).
- Suggested fix or mitigation, if available.

### Response Timeline

- **Initial Acknowledgement**: Within 48 hours.
- **Triage & Status Update**: Within 5 business days.
- **Fix & Advisory Release**: Coordinated with the reporter prior to public release.

---

## Public Issue & Community Etiquette

When opening normal bug reports or troubleshooting issues on GitHub:
- **NEVER** post unredacted logs containing real router passwords, Telegram bot tokens, API tokens, or encryption keys.
- **NEVER** post screenshots or text containing real personal phone numbers or one-time verification codes (OTPs).
- Always use RFC-compliant placeholders (`192.168.8.1`, `sms.example.com`, `+353831234567`, `123456:FAKE_TOKEN`).
