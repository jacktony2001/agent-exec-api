// Tests for the exec API. Runs against the real HTTP server on an ephemeral
// port — no mocks. Commands use `node -e` where possible so they behave the
// same under bash (Linux/prod) and cmd.exe (Windows/dev).
//
//   npm test
import test from "node:test";
import assert from "node:assert/strict";
import { createExecServer } from "../server.js";

const TOKEN = "test-token-123";

async function withServer(options, fn) {
  const server = createExecServer({ token: TOKEN, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() || {};
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`server did not get a usable port (got ${port})`);
  }
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({
      base,
      exec: (body, token = TOKEN) =>
        fetch(`${base}/exec`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {})
          },
          body: typeof body === "string" ? body : JSON.stringify(body)
        })
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("answers the probe styles hosts actually use", async () => {
  await withServer({}, async ({ base, exec }) => {
    // GET on each alias, plus HEAD — a probe that gets a 404 here is reported
    // by hosts as "service unreachable".
    for (const path of ["/", "/health", "/healthz"]) {
      const get = await fetch(`${base}${path}`);
      assert.equal(get.status, 200, `GET ${path}`);
      assert.equal((await get.json()).ok, true);
    }
    for (const path of ["/", "/health"]) {
      const head = await fetch(`${base}${path}`, { method: "HEAD" });
      assert.equal(head.status, 200, `HEAD ${path}`);
    }
    // Health stays public; /exec stays locked.
    assert.equal((await exec({ command: "echo x" }, null)).status, 401);
    assert.equal((await fetch(`${base}/not-a-probe`)).status, 404);
  });
});

test("custom health paths can be configured", async () => {
  await withServer({ healthPaths: "/alive" }, async ({ base }) => {
    assert.equal((await fetch(`${base}/alive`)).status, 200);
    assert.equal((await fetch(`${base}/health`)).status, 404, "default replaced");
    assert.equal((await fetch(`${base}/`)).status, 200, "root always answers");
  });
});

test("GET /health is public and does not leak config", async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, "agent-exec-api");
    assert.ok(!JSON.stringify(body).includes(TOKEN), "token never appears in output");
  });
});

test("fails closed when no token is configured", async () => {
  await withServer({ token: "" }, async ({ exec }) => {
    const res = await exec({ command: "echo should-not-run" }, "");
    assert.equal(res.status, 503);
  });
});

test("rejects missing and wrong credentials", async () => {
  await withServer({}, async ({ exec }) => {
    assert.equal((await exec({ command: "echo x" }, null)).status, 401);
    assert.equal((await exec({ command: "echo x" }, "wrong-token")).status, 401);
    assert.equal((await exec({ command: "echo x" }, `${TOKEN}-extra`)).status, 401);
  });
});

test("runs a command and returns exit code and output", async () => {
  await withServer({}, async ({ exec }) => {
    const res = await exec({ command: "echo hello-from-test" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.exitCode, 0);
    assert.ok(body.output.includes("hello-from-test"), `output was: ${body.output}`);
    assert.equal(body.timedOut, false);
    assert.equal(body.truncated, false);
    assert.ok(body.durationMs >= 0);
  });
});

test("propagates a non-zero exit code", async () => {
  await withServer({}, async ({ exec }) => {
    const body = await (await exec({ command: "exit 3" })).json();
    assert.equal(body.exitCode, 3);
  });
});

test("stderr is captured together with stdout", async () => {
  await withServer({}, async ({ exec }) => {
    const body = await (
      await exec({ command: 'node -e "console.error(\'to-stderr\')"' })
    ).json();
    assert.ok(body.output.includes("to-stderr"), `output was: ${body.output}`);
  });
});

test("kills a command that exceeds the timeout", async () => {
  await withServer({ timeoutMs: 700 }, async ({ exec }) => {
    const started = Date.now();
    const body = await (
      await exec({ command: 'node -e "setTimeout(() => {}, 30000)"' })
    ).json();
    assert.equal(body.timedOut, true, "timedOut flag set");
    assert.ok(body.output.includes("[timeout"), `output was: ${body.output}`);
    assert.ok(Date.now() - started < 10_000, "did not wait for the child to finish");
  });
});

test("truncates output beyond maxOutput", async () => {
  await withServer({ maxOutput: 2048 }, async ({ exec }) => {
    const body = await (
      await exec({ command: 'node -e "process.stdout.write(\'x\'.repeat(200000))"' })
    ).json();
    assert.equal(body.truncated, true);
    assert.ok(body.output.includes("[output truncated"));
    assert.ok(body.output.length < 6000, `output was ${body.output.length} chars`);
  });
});

test("validates the request body", async () => {
  await withServer({}, async ({ exec }) => {
    assert.equal((await exec("{not json")).status, 400);
    assert.equal((await exec({})).status, 400, "missing command");
    assert.equal((await exec({ command: "" })).status, 400, "empty command");
    assert.equal((await exec({ command: "echo ".repeat(2000) })).status, 413, "command too long");
  });
});

test("unknown routes return 404", async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const post = await fetch(`${base}/exec/../exec`, { method: "POST" });
    assert.ok(post.status === 404 || post.status === 401 || post.status === 400);
  });
});

test("a failed bind is logged instead of crashing the process", async () => {
  const first = createExecServer({ token: TOKEN });
  await new Promise((resolve) => first.listen(0, "127.0.0.1", resolve));
  const { port } = first.address();

  const events = [];
  const second = createExecServer({ token: TOKEN, log: (e) => events.push(e) });
  const failure = await new Promise((resolve) => {
    second.once("error", resolve);
    second.listen(port, "127.0.0.1");
  });

  assert.equal(failure.code, "EADDRINUSE", "the bind error reaches the caller");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    events.some((e) => e.event === "server_error" && e.code === "EADDRINUSE"),
    `expected a logged server_error, got ${JSON.stringify(events)}`
  );

  await new Promise((resolve) => second.close(resolve));
  await new Promise((resolve) => first.close(resolve));
});

test("rate limits a single client", async () => {
  await withServer({ rateLimit: 3 }, async ({ exec }) => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await exec({ command: "echo x" })).status);
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200], "first calls allowed");
    assert.ok(codes.slice(3).every((c) => c === 429), `expected 429s, got ${codes}`);
  });
});
