// Request and application logging.
//
// Local development gets compact, colorized lines when stdout is a terminal.
// Vercel/production gets one JSON object per line, ready for a log drain.
// Tune with LOG_LEVEL=debug|info|warn|error|silent and SLOW_REQUEST_MS.
import { randomUUID } from "node:crypto";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const configured = String(process.env.LOG_LEVEL || "").toLowerCase();
const isProd = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
const isTest = Boolean(process.env.NODE_TEST_CONTEXT) || process.argv.includes("--test");
const threshold = isTest && !configured ? LEVELS.silent : LEVELS[configured] ?? LEVELS.info;
const asJson = isProd || String(process.env.LOG_FORMAT || "").toLowerCase() === "json";
const slowSetting = Number(process.env.SLOW_REQUEST_MS);
const slowMs = Number.isFinite(slowSetting) && slowSetting >= 0 ? slowSetting : 1000;

const color = !asJson && !process.env.NO_COLOR
  && (process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : Boolean(process.stdout.isTTY));
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : String(text));
const dim = (text) => paint("2", text);
const bold = (text) => paint("1", text);
const yellow = (text) => paint("33", text);
const green = (text) => paint("32", text);
const red = (text) => paint("31", text);
const cyan = (text) => paint("36", text);

const METHOD_COLOR = { GET: "36", POST: "32", PUT: "34", PATCH: "33", DELETE: "31", OPTIONS: "35" };
const LEVEL_COLOR = { debug: "2", info: "36", warn: "33", error: "31" };

const requests = new WeakMap();
const responseStatus = new WeakMap();
const REQUEST_ID = /^[A-Za-z0-9._-]{8,80}$/;

const pad = (n, width = 2) => String(n).padStart(width, "0");
const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;

function duration(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`;
}

function statusPaint(status) {
  if (status >= 500) return red;
  if (status >= 400) return yellow;
  if (status >= 300) return cyan;
  return green;
}

function statusOf(set, response) {
  if (response instanceof Response) return response.status;
  const status = Number(set?.status);
  return Number.isInteger(status) && status > 0 ? status : 200;
}

function serializeMeta(meta) {
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    out[key] = value instanceof Error
      ? { name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}) }
      : value;
  }
  return out;
}

function prettyValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return /^[\w.:/@+-]+$/.test(text) ? text : JSON.stringify(text);
}

function prettyMeta(meta) {
  return Object.entries(meta)
    .filter(([key, value]) => key !== "error" && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${prettyValue(value)}`)
    .join(" ");
}

function write(level, message, meta = {}) {
  if (LEVELS[level] < threshold) return;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  const now = new Date();

  if (asJson) {
    stream.write(`${JSON.stringify({ time: now.toISOString(), level, msg: message, ...serializeMeta(meta) })}\n`);
    return;
  }

  const label = paint(LEVEL_COLOR[level], level.toUpperCase().padEnd(5));
  const details = prettyMeta(meta);
  stream.write(`${dim(clock(now))}  ${label}  ${message}${details ? `  ${details}` : ""}\n`);
  if (meta.error instanceof Error && meta.error.stack) {
    stream.write(`${meta.error.stack.replace(/^/gm, "  ")}\n`);
  }
}

export const log = {
  debug: (message, meta) => write("debug", message, meta),
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta)
};

export function beginRequest(request, set) {
  const supplied = request.headers.get("x-request-id");
  const requestId = supplied && REQUEST_ID.test(supplied) ? supplied : randomUUID();
  requests.set(request, { requestId, startedAt: performance.now() });
  if (set?.headers) {
    try {
      set.headers["x-request-id"] = requestId;
    } catch {
      // Default headers can be frozen by an adapter; the log id still works.
    }
  }
  return requestId;
}

export const requestIdOf = (request) => requests.get(request)?.requestId;

// Final responses bypass responseValue on some fast paths (CORS preflight, for example),
// so capture the real status from the mapped Response.
export function noteResponse(request, response) {
  if (response instanceof Response) responseStatus.set(request, response.status);
}

export function endRequest({ request, set, response, user }) {
  const state = requests.get(request);
  const startedAt = state?.startedAt ?? performance.now();
  const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
  const status = responseStatus.get(request) ?? statusOf(set, response);
  const slow = slowMs > 0 && durationMs >= slowMs;
  const level = status >= 500 ? "error" : slow ? "warn" : "info";
  if (LEVELS[level] < threshold) return;

  const url = new URL(request.url);
  const meta = {
    requestId: state?.requestId,
    method: request.method,
    path: url.pathname,
    query: url.search ? url.search.slice(1) : undefined,
    status,
    durationMs,
    userId: user?._id ? String(user._id) : undefined,
    role: user?.role,
    ip: (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || undefined
  };

  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  if (asJson) {
    stream.write(`${JSON.stringify({
      time: new Date().toISOString(),
      level,
      msg: slow && status < 500 ? "request.slow" : "request",
      ...serializeMeta(meta)
    })}\n`);
    return;
  }

  const method = paint(METHOD_COLOR[request.method] || "2", request.method.padEnd(7));
  const path = `${url.pathname}${url.search}`;
  const statusLabel = statusPaint(status)(String(status));
  const timing = dim(duration(durationMs).padStart(6));
  const slowLabel = slow ? `  ${bold(yellow("SLOW"))}` : "";
  const id = state?.requestId ? `  ${dim(`#${state.requestId.slice(0, 8)}`)}` : "";
  stream.write(`${dim(clock(new Date()))}  ${method} ${path}  ${statusLabel}  ${timing}${slowLabel}${id}\n`);
}
