import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectSmsTextMode } from "./crypto.js";
import { COUNTRY_DIAL_CODES, resolveRecipientPhone } from "./phone.js";
import { formatHuaweiDate } from "./xml.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "web", "public");
const SESSION_COOKIE_NAME = "cpe_sms_session";

/**
 * Compute deterministic HMAC session token from `apiToken` so valid browser cookies survive
 * restarts as long as `CPE_PASSWORD` / `API_TOKEN` remains unchanged.
 *
 * @param {string} secret
 * @returns {string}
 */
function makeSessionSignature(secret) {
  return crypto
    .createHmac("sha256", Buffer.from(secret, "utf8"))
    .update("cpe-sms-webui-session-v1")
    .digest("hex");
}

/**
 * Parse HTTP `Cookie` header into a key-value map.
 *
 * @param {string | undefined} cookieHeader
 * @returns {Record<string, string>}
 */
function parseCookies(cookieHeader) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return out;
}

/**
 * Timing-safe string comparison.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualStr(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify either `Authorization: Bearer <token>`, `X-API-Token`, or signed `HttpOnly` Web UI cookie.
 *
 * @param {http.IncomingMessage} req
 * @param {string} expectedToken
 * @returns {boolean}
 */
function isRequestAuthorized(req, expectedToken) {
  if (!expectedToken) return false;

  const authHeader = req.headers.authorization ?? "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const provided = authHeader.slice(7).trim();
    if (timingSafeEqualStr(provided, expectedToken)) return true;
  }
  if (typeof req.headers["x-api-token"] === "string") {
    if (timingSafeEqualStr(req.headers["x-api-token"].trim(), expectedToken)) return true;
  }

  const cookies = parseCookies(req.headers.cookie);
  const cookieSig = cookies[SESSION_COOKIE_NAME];
  if (cookieSig && timingSafeEqualStr(cookieSig, makeSessionSignature(expectedToken))) {
    return true;
  }

  return false;
}

/**
 * Read JSON request body up to `maxBytes`.
 *
 * @param {http.IncomingMessage} req
 * @param {number} [maxBytes=1048576]
 * @returns {Promise<Record<string, any>>}
 */
function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Send JSON HTTP response.
 *
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/**
 * Serve static files from `src/web/public`.
 *
 * @param {string} pathname
 * @param {http.ServerResponse} res
 * @returns {boolean}
 */
function serveStaticAsset(pathname, res) {
  const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relPath);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return false;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return false;
  }
  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const content = fs.readFileSync(resolved);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": content.length,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
  });
  res.end(content);
  return true;
}

/**
 * Create the HTTP REST API + real-time SSE + optional daisyUI Web App server.
 *
 * @param {{
 *   cpeClient: import("./cpe-client.js").HuaweiCpeClient,
 *   poller?: import("./poller.js").SmsPoller,
 *   archiveStore?: import("./sms-archive.js").SmsArchiveStore,
 *   contactStore?: import("./contacts.js").ContactStore,
 *   apiToken: string,
 *   defaultCountryCode?: string,
 *   serveWebUi?: boolean
 * }} deps
 */
export function createHttpApiServer(deps) {
  const {
    cpeClient,
    poller,
    archiveStore,
    contactStore,
    apiToken,
    defaultCountryCode = "+353",
    serveWebUi = false,
  } = deps;

  /** @type {Set<http.ServerResponse>} */
  const sseClients = new Set();

  /**
   * Broadcast a live event to all connected Web UI tabs.
   *
   * @param {string} event
   * @param {unknown} payload
   */
  const broadcastSse = (event, payload) => {
    if (sseClients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  if (archiveStore) {
    archiveStore.on("sms:new", (msg) => broadcastSse("sms:new", msg));
    archiveStore.on("sms:sent", (msg) => broadcastSse("sms:sent", msg));
    archiveStore.on("sms:updated", (info) => broadcastSse("sms:updated", info));
    archiveStore.on("sms:sync", (summary) => broadcastSse("sms:sync", summary));
    archiveStore.on("contacts:updated", (info) => broadcastSse("contacts:updated", info));
  }
  if (poller) {
    poller.on("status:update", (st) => broadcastSse("status:update", st));
  }

  const heartbeatInterval = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(": ping\n\n");
      } catch {
        sseClients.delete(client);
      }
    }
  }, 20000);
  heartbeatInterval.unref?.();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;
      const method = (req.method ?? "GET").toUpperCase();

      // 1. Unauthenticated health check
      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          service: "cpe-sms",
          webUi: serveWebUi,
          archiveCount: archiveStore?.messages.size ?? 0,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // 2. Static daisyUI Web App assets (auth is checked dynamically via `/api/auth/check`)
      if (serveWebUi && method === "GET" && !pathname.startsWith("/api/")) {
        if (serveStaticAsset(pathname, res)) return;
      }

      // 3. Web UI session auth endpoints
      if (method === "GET" && pathname === "/api/auth/check") {
        sendJson(res, 200, {
          ok: true,
          authenticated: isRequestAuthorized(req, apiToken),
          defaultCountryCode,
        });
        return;
      }

      if (method === "POST" && pathname === "/api/auth/login") {
        const body = await readJsonBody(req, 16384);
        const pwd = String(body.password ?? body.token ?? "").trim();
        if (!timingSafeEqualStr(pwd, apiToken)) {
          sendJson(res, 401, { ok: false, error: "密码或访问令牌错误" });
          return;
        }
        const sig = makeSessionSignature(apiToken);
        const maxAge = 30 * 24 * 3600;
        sendJson(
          res,
          200,
          { ok: true, defaultCountryCode },
          {
            "Set-Cookie": `${SESSION_COOKIE_NAME}=${sig}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`,
          }
        );
        return;
      }

      if (method === "POST" && pathname === "/api/auth/logout") {
        sendJson(
          res,
          200,
          { ok: true },
          {
            "Set-Cookie": `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
          }
        );
        return;
      }

      // 4. All remaining `/api/*` endpoints require Bearer token or authenticated cookie
      if (!isRequestAuthorized(req, apiToken)) {
        sendJson(res, 401, { ok: false, error: "Unauthorized: valid Bearer token or login required" });
        return;
      }

      // 5. Real-time Server-Sent Events (`/api/events`)
      if (method === "GET" && pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(
          `event: hello\ndata: ${JSON.stringify({
            archiveTotal: archiveStore?.messages.size ?? 0,
            contactsTotal: contactStore?.contacts.length ?? 0,
            cpeStats: archiveStore?.cpeStats ?? null,
            lastFullSyncAt: archiveStore?.lastFullSyncAt ?? null,
            defaultCountryCode,
          })}\n\n`
        );
        sseClients.add(res);
        req.on("close", () => {
          sseClients.delete(res);
        });
        return;
      }

      // 6. Device & signal status
      if (method === "GET" && pathname === "/api/status") {
        const summary = await cpeClient.getStatusSummary();
        sendJson(res, 200, {
          ok: true,
          data: {
            ...summary,
            archiveTotal: archiveStore?.messages.size ?? 0,
            contactsTotal: contactStore?.contacts.length ?? 0,
            lastFullSyncAt: archiveStore?.lastFullSyncAt ?? null,
            defaultCountryCode,
          },
        });
        return;
      }

      // 7. Historical SMS Archive & Thread endpoints for Web UI
      if (method === "GET" && pathname === "/api/archive/threads") {
        const search = url.searchParams.get("search") ?? "";
        const filterRaw = url.searchParams.get("filter") ?? "all";
        const filter =
          filterRaw === "unread" || filterRaw === "otp" ? filterRaw : "all";
        const threads = archiveStore ? archiveStore.listThreads({ search, filter }) : [];
        sendJson(res, 200, {
          ok: true,
          data: {
            threads,
            archiveTotal: archiveStore?.messages.size ?? 0,
            cpeStats: archiveStore?.cpeStats ?? null,
            lastFullSyncAt: archiveStore?.lastFullSyncAt ?? null,
            contactsTotal: contactStore?.contacts.length ?? 0,
            defaultCountryCode,
            countries: COUNTRY_DIAL_CODES,
          },
        });
        return;
      }

      if (method === "GET" && pathname === "/api/archive/thread") {
        const key = url.searchParams.get("key") ?? url.searchParams.get("phone") ?? "";
        if (!key) {
          sendJson(res, 400, { ok: false, error: "Missing key parameter" });
          return;
        }
        const detail = archiveStore ? archiveStore.getThreadDetail(key) : null;
        sendJson(res, 200, { ok: true, data: detail });
        return;
      }

      if (method === "POST" && pathname === "/api/archive/sync") {
        let dump = null;
        if (poller) {
          dump = await poller.syncFullHistory({ respectBrowserSession: false });
        } else {
          dump = await cpeClient.fetchAllMessages({ respectBrowserSession: false });
          if (dump && archiveStore) archiveStore.ingestFullDump(dump);
        }
        sendJson(res, 200, {
          ok: true,
          data: {
            syncedFromCpe: dump?.messages.length ?? 0,
            archiveTotal: archiveStore?.messages.size ?? 0,
            cpeStats: archiveStore?.cpeStats ?? null,
            lastFullSyncAt: archiveStore?.lastFullSyncAt ?? null,
          },
        });
        return;
      }

      // Preview encoding / segment count & recipient normalization
      if (method === "POST" && pathname === "/api/sms/preview") {
        const body = await readJsonBody(req, 32768);
        const countryCode = String(body.countryCode ?? defaultCountryCode);
        const resolved = body.phone
          ? resolveRecipientPhone(String(body.phone), countryCode)
          : null;
        const mode = detectSmsTextMode(String(body.content ?? ""));
        sendJson(res, 200, { ok: true, data: { recipient: resolved, mode } });
        return;
      }

      // 8. Contacts Book & iPhone `.vcf` Import endpoints
      if (method === "GET" && pathname === "/api/contacts/book") {
        const q = url.searchParams.get("search") ?? "";
        const list = contactStore ? contactStore.search(q, 500) : [];
        sendJson(res, 200, {
          ok: true,
          data: { total: contactStore?.contacts.length ?? 0, contacts: list },
        });
        return;
      }

      if (method === "POST" && pathname === "/api/contacts/book") {
        if (!contactStore) {
          sendJson(res, 501, { ok: false, error: "ContactStore not enabled" });
          return;
        }
        const body = await readJsonBody(req, 65536);
        const saved = contactStore.upsertManualContact({
          phone: body.phone,
          name: body.name,
          note: body.note,
        });
        archiveStore?.emit("contacts:updated", { total: contactStore.contacts.length });
        sendJson(res, 200, { ok: true, data: saved });
        return;
      }

      if (method === "POST" && pathname === "/api/contacts/import-vcf") {
        if (!contactStore) {
          sendJson(res, 501, { ok: false, error: "ContactStore not enabled" });
          return;
        }
        // Allow up to 10 MB `.vcf` file with thousands of iPhone contacts
        const body = await readJsonBody(req, 10 * 1024 * 1024);
        const stats = contactStore.importVcard(String(body.vcf ?? ""));
        archiveStore?.emit("contacts:updated", { total: stats.total });
        sendJson(res, 200, { ok: true, data: stats });
        return;
      }

      const delContactMatch = pathname.match(/^\/api\/contacts\/book\/([^/]+)$/);
      if (method === "DELETE" && delContactMatch) {
        const deleted = contactStore?.deleteContact(decodeURIComponent(delContactMatch[1])) ?? false;
        archiveStore?.emit("contacts:updated", { total: contactStore?.contacts.length ?? 0 });
        sendJson(res, 200, { ok: true, deleted });
        return;
      }

      // 9. Direct CPE SMS endpoints (compatible with external REST callers & Web UI)
      if (method === "GET" && pathname === "/api/contacts") {
        const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1;
        const count = Number.parseInt(url.searchParams.get("count") ?? "20", 10) || 20;
        const data = await cpeClient.listContacts({ page, count });
        sendJson(res, 200, { ok: true, data });
        return;
      }

      if (method === "GET" && pathname === "/api/messages") {
        const phone = url.searchParams.get("phone");
        const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1;
        const count = Number.parseInt(url.searchParams.get("count") ?? "20", 10) || 20;
        const unreadOnly =
          url.searchParams.get("unread") === "1" || url.searchParams.get("unread") === "true";

        if (phone) {
          const data = await cpeClient.listPhoneMessages(phone, { page, count });
          sendJson(res, 200, { ok: true, data });
        } else {
          const data = await cpeClient.fetchRecentInboxMessages({ count, unreadOnly });
          sendJson(res, 200, { ok: true, data });
        }
        return;
      }

      if (method === "POST" && pathname === "/api/send") {
        const body = await readJsonBody(req, 65536);
        const countryCode = String(body.countryCode ?? defaultCountryCode);
        const rawPhones = body.phones ?? body.phone;
        const content = String(body.content ?? body.message ?? body.text ?? "");

        const rawList = (Array.isArray(rawPhones) ? rawPhones : [rawPhones]).filter(Boolean);
        const resolvedPhones = rawList.map((p) => {
          const r = resolveRecipientPhone(String(p), countryCode);
          if (!r.ok) throw new Error(r.error);
          return r.phone;
        });

        const result = await cpeClient.sendSms(resolvedPhones, content);
        if (result.ok && archiveStore) {
          for (const ph of resolvedPhones) {
            archiveStore.recordRealtimeMessage(
              {
                index: 0,
                phone: ph,
                content: content.trim(),
                date: formatHuaweiDate(new Date()),
                smstat: "3",
                curbox: "1",
                isUnread: false,
                direction: "out",
              },
              "sms:sent"
            );
          }
        }
        sendJson(res, result.ok ? 200 : 502, {
          ok: result.ok,
          data: { ...result, resolvedPhones },
        });
        return;
      }

      if (method === "POST" && pathname === "/api/read") {
        const body = await readJsonBody(req, 65536);
        const indices = Array.isArray(body.indices) ? body.indices : [body.index].filter(Boolean);
        const result = await cpeClient.markRead(indices);
        archiveStore?.markReadByCpeIndices(indices);
        sendJson(res, 200, { ok: true, data: result });
        return;
      }

      if (method === "POST" && pathname === "/api/delete") {
        const body = await readJsonBody(req, 65536);
        const indices = Array.isArray(body.indices) ? body.indices.filter((n) => Number(n) > 0) : [];
        const uids = Array.isArray(body.uids) ? body.uids : [];
        const deleteFromCpe = body.deleteFromCpe !== false;
        const deleteFromArchive = Boolean(body.deleteFromArchive);

        if (deleteFromCpe && indices.length > 0) {
          await cpeClient.deleteSms(indices);
        }
        if (indices.length > 0) {
          archiveStore?.markDeletedByCpeIndices(indices, { removeFromArchive: deleteFromArchive });
        }
        if (deleteFromArchive && uids.length > 0) {
          archiveStore?.deleteArchiveUids(uids);
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/sync") {
        const found = poller ? await poller.syncOnce({ respectBrowserSession: false }) : [];
        sendJson(res, 200, { ok: true, syncedNewCount: found.length });
        return;
      }

      const delMatch = pathname.match(/^\/api\/messages\/(\d+)$/);
      if (method === "DELETE" && delMatch) {
        const result = await cpeClient.deleteSms([delMatch[1]]);
        archiveStore?.markDeletedByCpeIndices([delMatch[1]]);
        sendJson(res, 200, { ok: true, data: result });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const status = err.message === "Invalid JSON body" ? 400 : 500;
      sendJson(res, status, { ok: false, error: err.message });
    }
  });

  server.on("close", () => clearInterval(heartbeatInterval));
  return server;
}

/**
 * Create a standalone Web UI frontend + reverse proxy server (`node src/cli.js web`)
 * for optional decoupled Docker Compose deployment (`docker compose --profile web up -d`).
 *
 * Serves static daisyUI assets locally and streams `/api/*` + `/healthz` (including SSE)
 * to the upstream core daemon (`http://cpe-sms:8080`).
 *
 * @param {{ upstreamUrl: string }} opts
 */
export function createWebProxyServer(opts) {
  const upstream = new URL(opts.upstreamUrl);

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && !url.pathname.startsWith("/api/") && url.pathname !== "/healthz") {
      if (serveStaticAsset(url.pathname, res)) return;
    }

    const proxyReq = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port || 80,
        path: url.pathname + url.search,
        method: req.method,
        headers: {
          ...req.headers,
          host: upstream.host,
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (err) => {
      sendJson(res, 502, { ok: false, error: `Upstream cpe-sms unreachable: ${err.message}` });
    });

    req.pipe(proxyReq);
  });
}
