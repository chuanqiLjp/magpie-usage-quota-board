// 插件本地服务：只绑 127.0.0.1，随机 token，Host/Origin 校验。
// 页面在沙盒里（CSP connect-src 'none'），所以 page/ 是启动器，真正 UI 由本服务提供。
// 安全做法照抄 @magpie-community/page-usage-tree。
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayUsage, gatewayQuotas } from "./gateway.mjs";
import { buildQuotaBoard } from "./quota.mjs";
import { summarizeGateway, summarizeRows, totalOf, readUsageRows, readLastSeen } from "./usage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, "..", "ui");
const TOKEN = crypto.randomBytes(24).toString("hex");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// 沙盒页面（opaque origin，Origin: null）取自己的本地服务属于跨源请求，
// 所以**每个**响应都要带 CORS 头；只在预检里带不够，否则浏览器会拒收响应 → Failed to fetch。
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Max-Age": "600",
  // Chromium 的 Private Network Access：从不受信任来源（沙盒页是 opaque origin）
  // 访问回环地址时，预检会要求这一项
  "Access-Control-Allow-Private-Network": "true",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, {
    ...CORS,
    "Content-Type": type,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}
function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj));
}

function hostAllowed(req) {
  const host = String(req.headers.host || "");
  return /^127\.0\.0\.1:\d+$/.test(host) || /^localhost:\d+$/.test(host);
}
function originAllowed(req) {
  // 沙盒框架 Origin 为 null；同源为 http://127.0.0.1:PORT；其余拒绝
  const origin = String(req.headers.origin || "");
  return origin === "" || origin === "null" || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
}

function pageToken(req, url) {
  const auth = String(req.headers.authorization || "");
  if (auth === `Bearer ${TOKEN}`) return true;
  return url.searchParams.get("token") === TOKEN;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function route(req, res, url) {
  const p = url.pathname;
  // 页面 API（带 token）
  if (p === "/api/board") {
    if (!pageToken(req, url)) return sendJSON(res, 401, { error: "unauthorized" });
    try {
      const quotas = await gatewayQuotas();
      // 「最近请求时间」来自本地流水账（额度接口不带），失败不影响额度主数据
      let lastSeen = new Map();
      try {
        lastSeen = readLastSeen();
      } catch {}
      const board = buildQuotaBoard(quotas, lastSeen);
      return sendJSON(res, 200, board);
    } catch (error) {
      return sendJSON(res, 502, { error: String(error?.message || error) });
    }
  }
  if (p === "/api/usage") {
    if (!pageToken(req, url)) return sendJSON(res, 401, { error: "unauthorized" });
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: "invalid JSON" });
    const dim = ["model", "provider", "account", "harness"].includes(body.dim) ? body.dim : "model";
    const period = ["today", "7d", "30d", "all", "custom"].includes(body.period) ? body.period : "today";
    const from = typeof body.from === "string" ? body.from.trim() : "";
    const to = typeof body.to === "string" ? body.to.trim() : "";
    try {
      if (period === "custom" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(to) && from < to) {
        const rows = readUsageRows(from, to + ":59.9999999");
        const list = summarizeRows(rows, dim);
        return sendJSON(res, 200, { period, from, to, dim, source: "usage.jsonl", rows: list, total: totalOf(list) });
      }
      if (period === "custom") return sendJSON(res, 400, { error: "自定义区间需要合法的 from/to（YYYY-MM-DDTHH:mm）" });
      const body_ = await gatewayUsage(period);
      const list = summarizeGateway(body_, dim);
      return sendJSON(res, 200, { period, dim, source: "gateway", rows: list, total: totalOf(list) });
    } catch (error) {
      return sendJSON(res, 502, { error: String(error?.message || error) });
    }
  }
  if (p === "/api/settings") {
    if (!pageToken(req, url)) return sendJSON(res, 401, { error: "unauthorized" });
    return sendJSON(res, 200, { ok: true });
  }
  if (p === "/healthz") {
    return sendJSON(res, 200, { ok: true, service: "magpie-usage-quota-board" });
  }
  // 启动器入口：无 token 进入时由服务 302 到带 token 的页面（沙盒页面无法 fetch 拿 token）
  if (p === "/enter") {
    res.writeHead(302, { Location: `/?token=${TOKEN}` });
    return res.end();
  }
  // 静态文件（不含点号的路径当 index.html）
  const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR)) return sendJSON(res, 403, { error: "forbidden" });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJSON(res, 404, { error: "not found" });
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  return send(res, 200, fs.readFileSync(file), type);
}

const SERVICE = "magpie-usage-quota-board";

// 探测端口上是否已经有本插件的服务在跑（同一次 magpie 生命周期内正常只起一次；
// 但用户自验/进程残留时端口可能被本插件的旧实例占着，这时直接复用，而不是报错崩掉整个插件）。
function probeHealth(port, timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/healthz", timeout, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

export async function startServer({ port = 3499 } = {}) {
  const existing = await probeHealth(port);
  if (existing?.service === SERVICE) {
    console.log(`[${SERVICE}] port ${port} already serves this plugin — reusing it`);
    return { port, token: null, reused: true };
  }
  if (existing) {
    throw new Error(
      `端口 ${port} 已被另一个本地服务占用（它回应了 /healthz，但不是本插件）。` +
        `请在插件选项里把 port 改成别的端口，或关掉占用它的程序。`,
    );
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      // 访问日志：排查沙盒页取数问题时能直接看出请求是否到达、被什么状态码结束
      res.on("finish", () => {
        if (url.pathname.startsWith("/api/")) {
          console.log(
            `[${SERVICE}] ${req.method} ${url.pathname} origin=${req.headers.origin || "-"} -> ${res.statusCode}`,
          );
        }
      });
      if (!hostAllowed(req) || !originAllowed(req)) {
        return sendJSON(res, 403, { error: "forbidden host/origin" });
      }
      // CORS 预检（沙盒 opaque origin）
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        return res.end();
      }
      route(req, res, url).catch((error) => {
        try {
          sendJSON(res, 500, { error: String(error?.message || error) });
        } catch {}
      });
    });
    server.on("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        reject(
          new Error(
            `端口 ${port} 被占用，插件服务起不来。请在插件选项里改 port，或关掉占用该端口的程序。`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`[${SERVICE}] listening on http://127.0.0.1:${port} (token ${TOKEN.slice(0, 8)}…)`);
      resolve({ port, token: TOKEN, server });
    });
  });
}

// 直接 `node lib/server.mjs` 时提供 CLI 入口（本地自验用）：
// 服务把 token 打到 stdout；serve.mjs 包装为独立运行。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startServer({ port: Number(process.env.PORT || 3499) }).then((info) => {
    console.log("TOKEN=" + info.token);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
