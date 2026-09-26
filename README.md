# agent-exec-api

A tiny, authenticated command-execution endpoint.

**Why it exists:** a Cloudflare Worker has no shell and no filesystem. This is the
"missing computer" that a Worker-hosted agent (e.g. `rahmat-ai-bot`) calls so its
`run_shell` / `read_file` / `write_file` / `list_files` tools actually work.

```
Telegram → Cloudflare Worker (agent loop, no shell) → HTTPS → this service (bash)
```

Zero runtime dependencies. Node 20+ only.

## API

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| `GET` | `/health` | none (host health check) | `200 { ok: true, service }` |
| `POST` | `/exec` | `Authorization: Bearer $SHELL_TOKEN` | `{ "command": "ls -la", "cwd": "/workspace" }` → `{ exitCode, output, durationMs, timedOut, truncated }` |

### Security model

- **Fails closed** — with no `SHELL_TOKEN` configured, `/exec` always returns 503.
- Token compared in constant time (sha256 + `timingSafeEqual`), never logged.
- Per-IP rate limit (default 30/min), 64 KB body cap, 4000-char command cap.
- Output cap (default 60 000 chars) and hard timeout (default 20 s) — both kill
  the whole process tree (`process.kill(-pid)` on POSIX, `taskkill /T` on Windows).
- Runs as the unprivileged `node` user in the image; `/workspace` is writable.

Anyone holding the token has a shell as that user. Treat the token like a password.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port (the host injects this) |
| `SHELL_TOKEN` | — | **Required.** Bearer token for `/exec` |
| `CMD_TIMEOUT_MS` | `20000` | Hard kill timer per command (max 120 000) |
| `MAX_OUTPUT` | `60000` | Output truncation limit |
| `RATE_LIMIT_PER_MIN` | `30` | Per-IP requests/minute to `/exec` |
| `SHELL_BIN` | `bash` | Override the shell |

## Run locally

```bash
SHELL_TOKEN=my-secret node server.js
curl -s http://127.0.0.1:3000/health
curl -s -X POST http://127.0.0.1:3000/exec \
  -H "authorization: Bearer my-secret" \
  -H "content-type: application/json" \
  -d '{"command":"echo hello"}'
```

## Test

```bash
npm test        # 11 tests: auth, fail-closed, exit codes, timeout kill,
                # output truncation, body validation, rate limiting
```

## Deploy to VibeNest (free tier)

1. Push this directory to a GitHub repo.
2. VibeNest → **New project** → paste the repo URL.
3. Build pack: **Dockerfile** (an `apk add bash` is required — commands expect `bash -lc`).
4. **Secrets & env vars** → add `SHELL_TOKEN` (generate one, e.g. a 32-byte random string).
5. **Deploy** → copy the `*.vibenest.net` subdomain from the dashboard.
6. Verify from your machine before wiring up the Worker:

```bash
curl -s https://YOUR-SUBDOMAIN.vibenest.net/health
curl -s -X POST https://YOUR-SUBDOMAIN.vibenest.net/exec \
  -H "authorization: Bearer YOUR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"command":"uname -a && pwd"}'
```

Free-tier ceiling: 256 MB RAM / 0.5 vCPU. Light commands are fine; heavy builds
will hit the memory limit.

## Wiring it into the Worker

In `cloudflare-erfan/rahmat-ai-bot` the `sandboxExec()` method currently calls a
Cloudflare Container. Pointing it here means: read `SHELL_ENDPOINT` + `SHELL_TOKEN`
(worker secret), `fetch(POST /exec)` instead of `getContainer(...)` — the four
tools, quoting, output limits and gating stay exactly as they are.
