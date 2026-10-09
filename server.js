"use strict";
// Ivay launch board: a dependency-free Node server with team login,
// a JSON store on a persistent volume and live updates over SSE.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const log = (level, msg, extra = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + "\n");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) { log("error", `missing required env var ${name}`); process.exit(1); }
  return v;
}
const SESSION_SECRET = requireEnv("SESSION_SECRET");
const BOARD_PASSCODE = requireEnv("BOARD_PASSCODE");
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || "/data";
const DATA_FILE = path.join(DATA_DIR, "board.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const VERSION = { sha: process.env.SOURCE_COMMIT || process.env.GIT_SHA || "dev", built: new Date().toISOString() };

const PEOPLE = ["Saleeta", "Zain", "Musharaf"];
const OWNERS = [...PEOPLE, "Team"];
const STATUSES = ["todo", "doing", "review", "done"];
const AREAS = ["deploy", "backend", "frontend", "apps", "qa", "marketing"];
const SIZES = ["S", "M", "L"];
const PRIOS = ["launch", "stretch", "later"];
const PRIORITIES = ["blocker", "high", "low"];
const SESSION_DAYS = 30;
const MAX_ACTIVITY = 300;

/* ---------- store ---------- */
let state = null;
let writeChain = Promise.resolve();

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    state = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    log("info", "loaded board", { cards: Object.keys(state.cards).length });
    // Add task briefs from the seed to existing boards, keeping any notes people wrote.
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-cards.json"), "utf8"));
    let briefed = 0;
    for (const [id, c] of Object.entries(state.cards)) {
      const brief = seed[id] && seed[id].note;
      if (!brief || !brief.startsWith("• ") || (c.note || "").startsWith("• ")) continue;
      c.note = c.note && !brief.includes(c.note.trim()) ? brief.split("\n\nNote: ")[0] + "\n\nNote: " + c.note.trim() : brief;
      briefed++;
    }
    if (briefed) { fs.writeFileSync(DATA_FILE, JSON.stringify(state)); log("info", "added task briefs", { cards: briefed }); }
  } else {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-cards.json"), "utf8"));
    state = { cards: seed, activity: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(state));
    log("info", "seeded board", { cards: Object.keys(seed).length });
  }
  applyBoardUpdates();
}
// One-time board updates (new cards, status moves, note additions), each applied once per board.
function applyBoardUpdates() {
  const file = path.join(__dirname, "board-updates.json");
  if (!fs.existsSync(file)) return;
  state.applied = state.applied || [];
  let changed = false;
  for (const u of JSON.parse(fs.readFileSync(file, "utf8"))) {
    if (state.applied.includes(u.id)) continue;
    for (const [id, card] of Object.entries(u.add || {})) if (!state.cards[id]) state.cards[id] = card;
    for (const [id, p] of Object.entries(u.patch || {})) {
      const c = state.cards[id]; if (!c) continue;
      if (p.status && c.status !== "done") c.status = p.status;
      if (p.note_add && !(c.note || "").includes(p.note_add.trim())) c.note = (c.note || "") + p.note_add;
      if (p.deps_add) c.deps = [...new Set([...(c.deps || []), ...p.deps_add])];
    }
    state.applied.push(u.id); changed = true;
    log("info", "applied board update", { id: u.id });
  }
  if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(state));
}
function persist() {
  const snapshot = JSON.stringify(state);
  writeChain = writeChain.then(async () => {
    const tmp = DATA_FILE + ".tmp";
    await fs.promises.writeFile(tmp, snapshot);
    await fs.promises.rename(tmp, DATA_FILE);
  }).catch(e => log("error", "persist failed", { err: e.message }));
  return writeChain;
}
function addActivity(who, text) {
  state.activity.unshift({ ts: new Date().toISOString(), who, text });
  if (state.activity.length > MAX_ACTIVITY) state.activity.length = MAX_ACTIVITY;
}
const isBlocked = c => c.status !== "done" && (c.deps || []).some(d => state.cards[d] && state.cards[d].status !== "done");

/* ---------- sessions ---------- */
const sign = v => crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("base64url");
function makeToken(name) {
  const payload = Buffer.from(JSON.stringify({ name, exp: Date.now() + SESSION_DAYS * 864e5 })).toString("base64url");
  return payload + "." + sign(payload);
}
function readSession(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const good = sign(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString());
    return s.exp > Date.now() && PEOPLE.includes(s.name) ? s.name : null;
  } catch { return null; }
}
function cookie(req, value, maxAge) {
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
  return `sid=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 10 * 60e3;
  const list = (attempts.get(ip) || []).filter(t => now - t < win);
  list.push(now); attempts.set(ip, list);
  return list.length > 10;
}

/* ---------- live updates ---------- */
const clients = new Set();
function broadcast() {
  const msg = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25e3).unref();

/* ---------- helpers ---------- */
function send(res, code, body, headers = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store", ...headers });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 64e3) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}
const isDate = v => v === null || v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v);
const str = (v, max) => typeof v === "string" && v.length <= max;

const STATUS_WORD = { todo: "moved back to Ready", doing: "started", review: "sent to review", done: "finished" };

function applyPatch(id, body, who) {
  const c = state.cards[id];
  if (!c) return { code: 404, body: { error: "That card doesn't exist any more. Reload the board." } };
  const next = { ...c };
  if ("status" in body) { if (!STATUSES.includes(body.status)) return bad("status"); next.status = body.status; }
  if ("owner" in body) { if (body.owner !== "" && !OWNERS.includes(body.owner)) return bad("owner"); next.owner = body.owner; }
  if ("priority" in body) { if (!PRIORITIES.includes(body.priority)) return bad("priority"); next.priority = body.priority; }
  if ("size" in body) { if (!SIZES.includes(body.size)) return bad("size"); next.size = body.size; }
  if ("start" in body) { if (!isDate(body.start)) return bad("start"); next.start = body.start || null; }
  if ("due" in body) { if (!isDate(body.due)) return bad("due"); next.due = body.due || null; }
  if ("note" in body) { if (!str(body.note, 4000)) return bad("note"); next.note = body.note; }
  if (body.kudos === true) { const k = new Set(c.kudos || []); k.add(who); next.kudos = [...k]; }

  const blockedIds = Object.keys(state.cards).filter(k => state.cards[k].status === "todo" && isBlocked(state.cards[k]));
  if (next.status !== c.status) next.doneAt = next.status === "done" ? new Date().toISOString() : null;
  next.updatedAt = new Date().toISOString(); next.updatedBy = who;
  state.cards[id] = next;

  let unblocked = [];
  if (next.status !== c.status) {
    addActivity(who, `${who} ${STATUS_WORD[next.status]} “${c.title}”`);
    if (next.status === "done") {
      unblocked = blockedIds.filter(k => !isBlocked(state.cards[k])).map(k => ({ id: k, title: state.cards[k].title, owner: state.cards[k].owner }));
      if (unblocked.length) addActivity(who, `Unblocked: ${unblocked.map(u => u.title).join(", ")}`);
    }
  }
  if (next.owner !== c.owner) addActivity(who, next.owner === who ? `${who} took “${c.title}”` : next.owner ? `${who} gave “${c.title}” to ${next.owner}` : `${who} put “${c.title}” back as unclaimed`);
  if (next.priority !== c.priority) addActivity(who, `${who} set “${c.title}” to ${next.priority} priority`);
  if (body.kudos === true && !(c.kudos || []).includes(who)) addActivity(who, `${who} sent kudos to ${c.owner || "the team"} for “${c.title}”`);
  return { code: 200, body: { card: { ...next, id }, unblocked } };
}
const bad = f => ({ code: 400, body: { error: `Invalid value for ${f}.` } });

function createCard(body, who) {
  if (!str(body.title, 140) || !body.title.trim()) return bad("title");
  if (!AREAS.includes(body.area)) return bad("area");
  if (body.owner !== "" && !OWNERS.includes(body.owner)) return bad("owner");
  if (!PRIORITIES.includes(body.priority)) return bad("priority");
  if (!SIZES.includes(body.size)) return bad("size");
  if (!PRIOS.includes(body.prio)) return bad("prio");
  if (!isDate(body.start) || !isDate(body.due)) return bad("date");
  const group = str(body.group, 60) && body.group.trim() ? body.group.trim() : body.area;
  const id = "c-" + crypto.randomBytes(5).toString("hex");
  state.cards[id] = {
    title: body.title.trim(), group, area: body.area, owner: body.owner, start: body.start || null, due: body.due || null,
    deps: [], prio: body.prio, priority: body.priority, size: body.size, note: "", status: "todo", kudos: [], doneAt: null,
    updatedAt: new Date().toISOString(), updatedBy: who,
  };
  addActivity(who, `${who} added “${state.cards[id].title}”`);
  return { code: 201, body: { card: { ...state.cards[id], id } } };
}

const OPENAPI = {
  openapi: "3.0.3", info: { title: "Ivay launch board", version: "1.0.0" },
  paths: {
    "/health": { get: { summary: "Liveness" } }, "/ready": { get: { summary: "Readiness (store loaded)" } },
    "/version": { get: { summary: "Build info" } },
    "/api/login": { post: { summary: "Sign in with {name, passcode}" } }, "/api/logout": { post: { summary: "Sign out" } },
    "/api/me": { get: { summary: "Current user" } }, "/api/state": { get: { summary: "All cards and recent activity" } },
    "/api/events": { get: { summary: "Server-sent events with the full state on every change" } },
    "/api/cards": { post: { summary: "Create a card" } }, "/api/cards/{id}": { patch: { summary: "Update status, owner (empty = unclaimed), priority, size, dates, note or kudos" } },
  },
};

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/health") return send(res, 200, { status: "ok" });
    if (p === "/ready") return state ? send(res, 200, { status: "ready" }) : send(res, 503, { status: "starting" });
    if (p === "/version") return send(res, 200, VERSION);
    if (p === "/openapi.json") return send(res, 200, OPENAPI);

    if (p === "/api/login" && req.method === "POST") {
      const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      if (rateLimited(ip)) return send(res, 429, { error: "Too many tries. Wait ten minutes and try again." });
      const b = await readBody(req);
      const okName = PEOPLE.includes(b.name);
      const given = Buffer.from(String(b.passcode || "")), want = Buffer.from(BOARD_PASSCODE);
      const okPass = given.length === want.length && crypto.timingSafeEqual(given, want);
      if (!okName || !okPass) { log("warn", "login failed", { name: okName ? b.name : "unknown" }); return send(res, 401, { error: "That passcode doesn't match. Ask Zain for the team passcode." }); }
      log("info", "login", { name: b.name });
      return send(res, 200, { name: b.name }, { "Set-Cookie": cookie(req, makeToken(b.name), SESSION_DAYS * 86400) });
    }
    if (p === "/api/logout" && req.method === "POST") return send(res, 200, { ok: true }, { "Set-Cookie": cookie(req, "", 0) });

    if (p.startsWith("/api/")) {
      const who = readSession(req);
      if (!who) return send(res, 401, { error: "Sign in to see the board." });
      if (p === "/api/me") return send(res, 200, { name: who });
      if (p === "/api/state" && req.method === "GET") return send(res, 200, state);
      if (p === "/api/events" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write(`data: ${JSON.stringify(state)}\n\n`);
        clients.add(res); req.on("close", () => clients.delete(res));
        return;
      }
      if (p === "/api/cards" && req.method === "POST") {
        const r = createCard(await readBody(req), who);
        if (r.code < 300) { await persist(); broadcast(); }
        return send(res, r.code, r.body);
      }
      const m = /^\/api\/cards\/([A-Za-z0-9_-]{1,40})$/.exec(p);
      if (m && req.method === "PATCH") {
        const r = applyPatch(m[1], await readBody(req), who);
        if (r.code < 300) { await persist(); broadcast(); log("info", "card updated", { id: m[1], by: who }); }
        return send(res, r.code, r.body);
      }
      return send(res, 404, { error: "Not found" });
    }

    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return fs.createReadStream(path.join(PUBLIC_DIR, "index.html")).pipe(res);
    }
    return send(res, 404, "Not found");
  } catch (e) {
    log("error", "request failed", { path: p, err: e.message });
    if (!res.headersSent) send(res, 400, { error: "That request couldn't be read." });
  }
});

loadState();
server.listen(PORT, () => log("info", "listening", { port: PORT }));
process.on("SIGTERM", () => { server.close(); writeChain.finally(() => process.exit(0)); });
