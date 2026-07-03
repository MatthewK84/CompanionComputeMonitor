/**
 * Edge Telemetry Console server: static bundle + same-origin agent relay.
 *
 * Why a relay: when this console is served over HTTPS (Railway), the
 * browser cannot fetch plain-HTTP LAN agents (mixed content / private
 * network access). The console instead calls same-origin
 *   GET /agent/<host>/<port>/telemetry
 * and this server forwards to the device — directly, or through the
 * tailscaled userspace HTTP proxy when TAILSCALE_PROXY is set.
 *
 * Node 20+, standard library only. No npm runtime dependencies.
 */

import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ host: string, port: number, agentPath: string }} AgentTarget */

const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const LISTEN_PORT = parsePort(process.env.PORT) ?? 8080;
const TAILSCALE_PROXY = process.env.TAILSCALE_PROXY ?? "";
// Cross-origin allowance for bridge mode: when this server runs on a
// ZeroTier/VPN-joined node and the console UI is served from elsewhere
// (e.g. Railway), the browser calls /agent cross-origin. Default "*" is
// acceptable for read-only telemetry on a private overlay; set CORS_ORIGIN
// to the console's exact origin to tighten.
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
const UPSTREAM_TIMEOUT_MS = 1500;

const AGENT_ROUTE = /^\/agent\/([0-9.]{7,15})\/(\d{1,5})\/(telemetry|healthz)$/;

/** Allowed upstream ranges: RFC 1918 + Tailscale CGNAT. Blocks SSRF to
 *  public internet, loopback, and link-local from the relay. */
const ALLOWED_RANGES = Object.freeze([
  { base: ipv4ToInt("10.0.0.0"), bits: 8 },
  { base: ipv4ToInt("172.16.0.0"), bits: 12 },
  { base: ipv4ToInt("192.168.0.0"), bits: 16 },
  { base: ipv4ToInt("100.64.0.0"), bits: 10 },
]);

const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
});

/** @param {string|undefined} raw @returns {number|null} */
function parsePort(raw) {
  if (raw === undefined) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return null;
  }
  return value;
}

/** @param {string} ip @returns {number} Unsigned 32-bit value, or NaN. */
function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return Number.NaN;
  }
  let value = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== part) {
      return Number.NaN;
    }
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** @param {string} host @returns {boolean} */
function isAllowedUpstream(host) {
  const value = ipv4ToInt(host);
  if (Number.isNaN(value)) {
    return false;
  }
  return ALLOWED_RANGES.some((range) => {
    const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
    return (value & mask) === (range.base & mask);
  });
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {object} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
  });
  res.end(body);
}

/**
 * Build upstream request options: direct, or absolute-URI form through the
 * tailscaled forward proxy when TAILSCALE_PROXY is configured.
 * @param {AgentTarget} target @returns {http.RequestOptions}
 */
function upstreamOptions(target) {
  const upstreamUrl = `http://${target.host}:${target.port}/${target.agentPath}`;
  if (TAILSCALE_PROXY === "") {
    return {
      host: target.host,
      port: target.port,
      path: `/${target.agentPath}`,
      method: "GET",
      timeout: UPSTREAM_TIMEOUT_MS,
    };
  }
  const proxy = new URL(TAILSCALE_PROXY);
  return {
    host: proxy.hostname,
    port: parsePort(proxy.port) ?? 1055,
    path: upstreamUrl,
    method: "GET",
    timeout: UPSTREAM_TIMEOUT_MS,
    headers: { Host: `${target.host}:${target.port}` },
  };
}

/**
 * @param {AgentTarget} target
 * @param {http.ServerResponse} res
 */
function relayToAgent(target, res) {
  const upstream = http.request(upstreamOptions(target), (agentRes) => {
    res.writeHead(agentRes.statusCode ?? 502, {
      "Content-Type": agentRes.headers["content-type"] ?? "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": CORS_ORIGIN,
    });
    agentRes.pipe(res);
  });
  upstream.on("timeout", () => {
    upstream.destroy(new Error("upstream timeout"));
  });
  upstream.on("error", (error) => {
    console.error(`Relay to ${target.host}:${target.port} failed: ${error.message}`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: "agent unreachable", host: target.host });
      return;
    }
    res.destroy();
  });
  upstream.end();
}

/**
 * @param {string} urlPath
 * @param {http.ServerResponse} res
 * @returns {boolean} Whether the request was handled as an agent relay.
 */
function handleAgentRoute(urlPath, res) {
  const match = AGENT_ROUTE.exec(urlPath);
  if (match === null) {
    return false;
  }
  const host = match[1] ?? "";
  const port = parsePort(match[2]);
  const agentPath = match[3] ?? "telemetry";
  if (port === null) {
    sendJson(res, 400, { error: "invalid port" });
    return true;
  }
  if (!isAllowedUpstream(host)) {
    sendJson(res, 403, {
      error: "host not in allowed ranges (RFC 1918 or Tailscale 100.64/10)",
    });
    return true;
  }
  relayToAgent({ host, port, agentPath }, res);
  return true;
}

/**
 * @param {string} urlPath
 * @param {http.ServerResponse} res
 */
function serveStatic(urlPath, res) {
  if (!existsSync(DIST_DIR)) {
    // Bridge mode: relay-only node with no UI bundle deployed.
    sendJson(res, 404, { error: "no UI bundle on this node (relay-only bridge)" });
    return;
  }
  const cleaned = urlPath === "/" ? "/index.html" : urlPath;
  const resolved = path.normalize(path.join(DIST_DIR, cleaned));
  const isInsideDist = resolved.startsWith(DIST_DIR + path.sep) || resolved === path.join(DIST_DIR, "index.html");
  const target = isInsideDist && existsSync(resolved) && statSync(resolved).isFile()
    ? resolved
    : path.join(DIST_DIR, "index.html");
  const ext = path.extname(target);
  const immutable = cleaned.startsWith("/assets/");
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(target)
    .on("error", (error) => {
      console.error(`Static read failed for ${target}: ${error.message}`);
      res.destroy();
    })
    .pipe(res);
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function route(req, res) {
  const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "GET only" });
    return;
  }
  if (urlPath === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      relay: TAILSCALE_PROXY !== "" ? "tailscale" : "direct",
      ui: existsSync(DIST_DIR),
    });
    return;
  }
  if (handleAgentRoute(urlPath, res)) {
    return;
  }
  serveStatic(urlPath, res);
}

function main() {
  const server = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (error) {
      console.error(`Unhandled route error: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      }
    }
  });
  server.listen(LISTEN_PORT, () => {
    console.log(
      `Console listening on :${LISTEN_PORT} (relay mode: ${TAILSCALE_PROXY !== "" ? `tailscale via ${TAILSCALE_PROXY}` : "direct"})`
    );
  });
}

main();
