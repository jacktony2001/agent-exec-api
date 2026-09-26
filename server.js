/**
 * agent-exec-api — authenticated command-execution endpoint.
 *
 * Built to sit behind HTTPS on a small free host (e.g. VibeNest) and be called
 * by a Cloudflare Worker, which has no shell and no filesystem of its own.
 *
 * Security model
 *   - Fails closed: without SHELL_TOKEN configured, /exec always returns 503.
 *   - Bearer token compared in constant time (sha256 + timingSafeEqual).
 *   - Per-IP rate limit, request-body cap, command-length cap, output cap, hard timeout.
 *   - Commands run in a child process group so a timeout kills the whole tree.
 *   - The Docker image drops to the unprivileged `node` user.
 *
 * Endpoints
 *   GET  /health   → 200 { ok }        public — used by the host's health check
 *   POST /exec     → 200 { exitCode, output, durationMs, timedOut, truncated }
 *                    body: { "command": "ls -la", "cwd": "/workspace" }
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMMAND_CHARS = 4000;
const DETACHED_KILL = process.platform !== "win32";

const DEFAULT_SHELL = process.env.SHELL_BIN || (process.platform === "win32" ? "cmd.exe" : "bash");

const clamp = (n, lo, hi) => Math.min(Math.max(Number(n) || 0, lo), hi);

const isCmd = (bin) => /(^|[\\/])cmd(\.exe)?$/i.test(bin);

function tokenMatches(provided, expected) {
  if (!expected) return false;
  const a = createHash("sha256").update(String(provided ?? "")).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

function shellArgs(shellBin, command) {
  return isCmd(shellBin) ? ["/d", "/s", "/c", command] : ["-lc", command];
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        return; // keep draining so the response isn't cut off mid-flight
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) return resolve({ ok: false, error: "body too large" });
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({ ok: false, error: "empty body" });
      try {
        return resolve({ ok: true, value: JSON.parse(raw) });
      } catch {
        return resolve({ ok: false, error: "invalid JSON" });
      }
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

/**
 * @returns {Promise<{exitCode:number, output:string, durationMs:number, timedOut:boolean, truncated:boolean}>}
 */
function runCommand(shellBin, command, options) {
  const { cwd, timeoutMs, maxOutput } = options;
  return new Promise((resolve) => {
    const started = Date.now();
    let proc;
    try {
      proc = spawn(shellBin, shellArgs(shellBin, command), {
        cwd: cwd || process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: DETACHED_KILL,
        // Without this, Node wraps our command string in extra quotes and
        // cmd.exe hands a mangled program to node -e / bash -c callers.
        windowsVerbatimArguments: isCmd(shellBin)
      });
    } catch (err) {
      resolve({
        exitCode: -1,
        output: `spawn failed: ${err.message}`,
        durationMs: Date.now() - started,
        timedOut: false,
        truncated: false
      });
      return;
    }

    let out = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let graceTimer = null;

    const killTree = () => {
      try {
        if (DETACHED_KILL && proc.pid) {
          process.kill(-proc.pid, "SIGKILL"); // whole process group
        } else if (proc.pid) {
          // Windows: killing cmd.exe alone leaves grandchildren holding the
          // pipes open. /T kills the whole tree — but taskkill is async, so
          // don't also kill cmd first or it loses its chance to enumerate them.
          spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
            stdio: "ignore"
          }).on("error", () => {});
          setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              /* gone */
            }
          }, 75);
        }
      } catch {
        /* already gone */
      }
    };

    const append = (chunk) => {
      if (truncated) return;
      out += chunk.toString("utf8");
      if (out.length > maxOutput) {
        out = out.slice(0, maxOutput);
        truncated = true;
        killTree();
      }
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      // Release the pipes: a grandchild that inherited them must not keep
      // this process (or its event loop) alive after we've already answered.
      try {
        proc.stdout?.destroy();
        proc.stderr?.destroy();
      } catch {
        /* already gone */
      }
      resolve(result);
    };

    proc.on("error", (err) => {
      finish({
        exitCode: -1,
        output: `exec error: ${err.message}`,
        durationMs: Date.now() - started,
        timedOut,
        truncated
      });
    });

    const finalize = (code, signal) => {
      let output = out;
      if (timedOut) output += `\n[timeout after ${timeoutMs}ms — process killed]`;
      if (truncated) output += `\n[output truncated at ${maxOutput} chars]`;
      finish({
        exitCode: code === null ? (signal ? 124 : -1) : code,
        output,
        durationMs: Date.now() - started,
        timedOut,
        truncated
      });
    };

    // Prefer 'close' (all stdio drained). But a killed child's grandchildren
    // can inherit the pipes and keep them open for seconds — 'exit' plus a
    // short grace period stops them from holding the response hostage.
    proc.on("exit", (code, signal) => {
      graceTimer = setTimeout(() => finalize(code, signal), 150);
    });
    proc.on("close", (code, signal) => finalize(code, signal));
  });
}

/**
 * Build the HTTP server.
 * Options: { token, timeoutMs, maxOutput, rateLimit, shellBin, log }
 */
export function createExecServer(options = {}) {
  const token = String(options.token ?? "");
  const timeoutMs = clamp(options.timeoutMs || 20000, 250, 120000);
  const maxOutput = clamp(options.maxOutput || 60000, 1024, 500000);
  const rateLimit = clamp(options.rateLimit || 30, 1, 10000);
  const shellBin = String(options.shellBin || DEFAULT_SHELL);
  const log = typeof options.log === "function" ? options.log : () => {};

  const hits = new Map(); // ip -> { count, resetAt }

  function rateOk(ip) {
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + 60_000 };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (hits.size > 5000) {
      for (const [key, value] of hits) if (now >= value.resetAt) hits.delete(key);
    }
    return entry.count <= rateLimit;
  }

  async function handle(req, res) {
    const url = new URL(req.url || "/", "http://placeholder");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (path === "/health" || path === "/")) {
      return send(res, 200, { ok: true, service: "agent-exec-api" });
    }

    if (req.method !== "POST" || path !== "/exec") {
      return send(res, 404, { error: "not found" });
    }

    // fail closed — an unconfigured server never executes anything
    if (!token) return send(res, 503, { error: "SHELL_TOKEN is not configured" });

    const ip = clientIp(req);
    if (!rateOk(ip)) return send(res, 429, { error: "rate limit exceeded", retryInSeconds: 60 });

    const auth = req.headers.authorization || "";
    const provided = /^Bearer[ \t]+(\S+)/i.exec(auth);
    if (!provided || !tokenMatches(provided[1], token)) {
      return send(res, 401, { error: "unauthorized" });
    }

    const body = await readBody(req);
    if (!body.ok) return send(res, 400, { error: body.error });

    const command = typeof body.value?.command === "string" ? body.value.command.trim() : "";
    if (!command) return send(res, 400, { error: "command is required" });
    if (command.length > MAX_COMMAND_CHARS) {
      return send(res, 413, { error: `command too long (max ${MAX_COMMAND_CHARS} chars)` });
    }

    const cwd =
      typeof body.value?.cwd === "string" && body.value.cwd.trim()
        ? body.value.cwd.trim()
        : undefined;

    log({ event: "exec_start", ip, chars: command.length });
    const result = await runCommand(shellBin, command, { cwd, timeoutMs, maxOutput });
    log({
      event: "exec_done",
      exitCode: result.exitCode,
      ms: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated
    });
    return send(res, 200, result);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log({ event: "handler_error", error: String(err?.message ?? err) });
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  server.on("clientError", (_err, socket) => socket.end());
  // A failed bind (EADDRINUSE, EACCES) must surface as a clear log line. Left
  // unhandled, the 'error' event kills the process with a raw stack trace and
  // the host only reports "unhealthy / status unknown".
  server.on("error", (err) => {
    log({ event: "server_error", error: err.message, code: err.code });
  });
  return server;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const token = process.env.SHELL_TOKEN || "";
  const server = createExecServer({
    token,
    timeoutMs: process.env.CMD_TIMEOUT_MS,
    maxOutput: process.env.MAX_OUTPUT,
    rateLimit: process.env.RATE_LIMIT_PER_MIN,
    shellBin: process.env.SHELL_BIN,
    log: (event) => console.log(JSON.stringify(event))
  });

  if (!token) {
    console.error(
      JSON.stringify({
        event: "warning",
        message: "SHELL_TOKEN is not set — /exec will return 503 for every call"
      })
    );
  }

  // Fail loudly and immediately: a host that can't reach the port should see
  // why, rather than a container that is up but serving nothing.
  server.on("error", (err) => {
    console.error(
      JSON.stringify({
        event: "fatal",
        error: err.message,
        code: err.code,
        port
      })
    );
    process.exit(1);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "listening", port, shell: process.env.SHELL_BIN || DEFAULT_SHELL }));
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    });
  }
}
