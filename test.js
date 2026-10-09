"use strict";
// Smoke test: boots the server against a temp data dir and exercises the API.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

const PORT = 18080 + Math.floor(Math.random() * 1000);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "board-"));
const base = `http://127.0.0.1:${PORT}`;

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, SESSION_SECRET: "test-secret", BOARD_PASSCODE: "launch24" },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(base + "/health")).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.deepStrictEqual(await (await fetch(base + "/health")).json(), { status: "ok" });
    assert.strictEqual((await fetch(base + "/ready")).status, 200);
    assert.strictEqual((await fetch(base + "/api/state")).status, 401, "state needs a session");

    const bad = await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ name: "Zain", passcode: "nope" }) });
    assert.strictEqual(bad.status, 401);

    const ok = await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ name: "Zain", passcode: "launch24" }) });
    assert.strictEqual(ok.status, 200);
    const cookie = ok.headers.get("set-cookie").split(";")[0];
    const H = { cookie, "Content-Type": "application/json" };

    const state = await (await fetch(base + "/api/state", { headers: H })).json();
    assert.ok(Object.keys(state.cards).length >= 50);
    assert.strictEqual(state.cards["dep-host"].owner, "");
    assert.strictEqual(state.cards["dep-host"].priority, "blocker");

    let r = await fetch(base + "/api/cards/mk-research", { method: "PATCH", headers: H, body: JSON.stringify({ owner: "Zain", status: "done" }) });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.card.owner, "Zain");
    assert.ok(body.card.doneAt);
    assert.ok(body.unblocked.some(u => u.id === "mk-scrape"), "finishing market research unblocks the store list");

    r = await fetch(base + "/api/cards/dep-db", { method: "PATCH", headers: H, body: JSON.stringify({ priority: "urgent" }) });
    assert.strictEqual(r.status, 400, "unknown priority is rejected");

    r = await fetch(base + "/api/cards", { method: "POST", headers: H, body: JSON.stringify({ title: "Smoke card", area: "qa", owner: "", size: "S", prio: "launch", priority: "low", start: "", due: "" }) });
    assert.strictEqual(r.status, 201);

    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "board.json"), "utf8"));
    assert.strictEqual(saved.cards["mk-research"].status, "done", "changes persist to disk");
    assert.ok(saved.activity.length >= 3);
    console.log("all checks passed");
  } finally {
    proc.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exit(1); });
