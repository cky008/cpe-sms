import crypto from "node:crypto";
import http from "node:http";

/**
 * Timing-safe Bearer token verification.
 *
 * @param {http.IncomingMessage} req
 * @param {string} expectedToken
 * @returns {boolean}
 */
function isRequestAuthorized(req, expectedToken) {
  if (!expectedToken) return false;
  const authHeader = req.headers.authorization ?? "";
  let provided = "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    provided = authHeader.slice(7).trim();
  } else if (typeof req.headers["x-api-token"] === "string") {
    provided = req.headers["x-api-token"].trim();
  }
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expectedToken, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Read JSON body up to 64 KB.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<Record<string, any>>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 65536) {
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
 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Create an HTTP REST API server for NAS / Tailscale / Webhook / iOS Shortcuts integration.
 *
 * @param {{
 *   cpeClient: import("./cpe-client.js").HuaweiCpeClient,
 *   poller?: import("./poller.js").SmsPoller,
 *   apiToken: string
 * }} deps
 */
export function createHttpApiServer(deps) {
  const { cpeClient, poller, apiToken } = deps;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;
      const method = (req.method ?? "GET").toUpperCase();

      // Unauthenticated health probe for Docker / monitoring
      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: "cpe-sms", timestamp: new Date().toISOString() });
        return;
      }

      if (!isRequestAuthorized(req, apiToken)) {
        sendJson(res, 401, { ok: false, error: "Unauthorized: valid Bearer token required" });
        return;
      }

      if (method === "GET" && pathname === "/api/status") {
        const summary = await cpeClient.getStatusSummary();
        sendJson(res, 200, { ok: true, data: summary });
        return;
      }

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
        const unreadOnly = url.searchParams.get("unread") === "1" || url.searchParams.get("unread") === "true";

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
        const body = await readJsonBody(req);
        const phones = body.phones ?? body.phone;
        const content = body.content ?? body.message ?? body.text;
        const result = await cpeClient.sendSms(phones, content);
        sendJson(res, result.ok ? 200 : 502, { ok: result.ok, data: result });
        return;
      }

      if (method === "POST" && pathname === "/api/read") {
        const body = await readJsonBody(req);
        const indices = Array.isArray(body.indices) ? body.indices : [body.index].filter(Boolean);
        const result = await cpeClient.markRead(indices);
        sendJson(res, 200, { ok: true, data: result });
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
        sendJson(res, 200, { ok: true, data: result });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const status = err.message === "Invalid JSON body" ? 400 : 500;
      sendJson(res, status, { ok: false, error: err.message });
    }
  });
}
