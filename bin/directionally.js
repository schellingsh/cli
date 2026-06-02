#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const http = require("node:http");
const https = require("node:https");
const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");

// ---- version / constants ----------------------------------------------------

function readOwnVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch { return "0.0.0"; }
}

const VERSION = readOwnVersion();
const DEFAULT_API_BASE = "https://api.directionally.ai";
const PROJECT_ID_RELATIVE = path.join(".schelling", "project-id");
const SKILL_RELATIVE = path.join(".agents", "skills", "directionally", "SKILL.md");
const SKILL_CLAUDE_RELATIVE = path.join(".claude", "skills", "directionally", "SKILL.md");
const DEFAULT_SKILL_URL =
  "https://raw.githubusercontent.com/schellingsh/skill/refs/heads/experiment/streaming/.agents/skills/directionally/SKILL.md";

const OUTCOME_VALUES = new Set([
  "helped_direction",
  "helped_implementation",
  "irrelevant",
  "missing_memory",
]);

// ---- helpers ----------------------------------------------------------------

function getApiBase() {
  return (process.env.DIRECTIONALLY_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function userAgent() { return `directionally/${VERSION}`; }

function userError(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}

function fail(msg, code = 1) { console.error(msg); process.exit(code); }

function nowIso() { return new Date().toISOString(); }

// ---- stdout queue -----------------------------------------------------------
// Serialises all stdout writes so async response streams can't interleave.

let _stdoutQueue = Promise.resolve();
function writeStdout(obj) {
  _stdoutQueue = _stdoutQueue.then(() => {
    process.stdout.write(JSON.stringify(obj) + "\n");
  });
}

// ---- project-id resolution --------------------------------------------------

function findGitRoot(startDir) {
  try {
    const out = execFileSync(
      "git", ["-C", startDir, "rev-parse", "--is-inside-work-tree", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines[0] === "true" ? (lines[1] || null) : null;
  } catch { return null; }
}

function findSchellingRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, PROJECT_ID_RELATIVE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findProjectRoot(startDir) {
  return findGitRoot(startDir) || findSchellingRoot(startDir);
}

function getProjectId(startDir) {
  const root = findProjectRoot(startDir);
  if (!root) return null;
  try {
    const raw = fs.readFileSync(path.join(root, PROJECT_ID_RELATIVE), "utf8");
    return raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0) || null;
  } catch { return null; }
}

// ---- HTTP helpers -----------------------------------------------------------

function pickModule(apiBase) {
  return apiBase.startsWith("https") ? https : http;
}

function urlParts(apiBase, pathname) {
  const u = new URL(apiBase + pathname);
  return {
    hostname: u.hostname,
    port: u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + (u.search || ""),
    protocol: u.protocol,
  };
}

function dbg(...args) {
  if (process.env.DIRECTIONALLY_DEBUG) process.stderr.write("[debug] " + args.join(" ") + "\n");
}

// ---- file tail stream -------------------------------------------------------

function createFileTailStream(filePath) {
  const { PassThrough } = require("node:stream");
  const stream = new PassThrough();
  let pos = 0;

  function readNew() {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > pos) {
        const buf = Buffer.alloc(stat.size - pos);
        const fd = fs.openSync(filePath, "r");
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        pos = stat.size;
        stream.write(buf);
      }
    } catch { /* ignore transient errors */ }
  }

  readNew();
  fs.watchFile(filePath, { interval: 100, persistent: true }, readNew);
  stream.on("close", () => fs.unwatchFile(filePath, readNew));
  return stream;
}

// ---- bridge -----------------------------------------------------------------

// Set by cmdBridge when --tailtmp is active so openBridgeStream can symlink
// the session_id back to the input file once the backend assigns one.
let _tailtmpInputFile = null;

function openBridgeStream(projectId, apiBase) {
  const parts = urlParts(apiBase, `/sessions/${encodeURIComponent(projectId)}`);
  const mod = pickModule(apiBase);
  const state = { req: null, sessionId: null, seq: 0 };

  dbg(`POST ${apiBase}/sessions/${encodeURIComponent(projectId)}`);

  const req = mod.request({
    ...parts,
    method: "POST",
    headers: {
      "content-type": "application/x-ndjson",
      "accept": "application/x-ndjson",
      "transfer-encoding": "chunked",
      "user-agent": userAgent(),
    },
  }, (res) => {
    dbg(`bridge stream response: HTTP ${res.statusCode}`);
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let pos;
      while ((pos = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, pos).trim();
        buf = buf.slice(pos + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        if (obj.kind === "event_received") {
          if (typeof obj.sequence === "number") state.seq = obj.sequence;
          continue;
        }

        if (obj.kind === "session_started") {
          state.sessionId = obj.session_id;
          if (_tailtmpInputFile && obj.session_id) {
            const linkPath = path.join(path.dirname(_tailtmpInputFile), obj.session_id);
            try {
              if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
              fs.symlinkSync(_tailtmpInputFile, linkPath);
            } catch { /* non-fatal */ }
            writeStdout({ kind: "bridge_started", api_base: apiBase, project_id: projectId, session_id: obj.session_id, received_at: nowIso() });
          }
        }

        writeStdout(obj);
      }
    });
    res.on("end", () => {});
    res.on("error", (err) => {
      writeStdout({ kind: "bridge_error", error: err.message, received_at: nowIso() });
    });
  });

  req.on("error", (err) => {
    dbg(`bridge stream error: ${err.message}`);
    writeStdout({ kind: "bridge_error", error: err.message, received_at: nowIso() });
  });

  req.flushHeaders();
  state.req = req;
  return state;
}

function openResumeStream(sessionId, seq, projectId, apiBase) {
  const parts = urlParts(apiBase, `/session/resume/${encodeURIComponent(sessionId)}?after=${seq}`);
  const mod = pickModule(apiBase);
  const state = { req: null, sessionId, seq };

  dbg(`POST ${apiBase}/session/resume/${encodeURIComponent(sessionId)}?after=${seq}`);

  const req = mod.request({
    ...parts,
    method: "POST",
    headers: {
      "content-type": "application/x-ndjson",
      "accept": "application/x-ndjson",
      "transfer-encoding": "chunked",
      "user-agent": userAgent(),
    },
  }, (res) => {
    dbg(`resume stream response: HTTP ${res.statusCode}`);
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let pos;
      while ((pos = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, pos).trim();
        buf = buf.slice(pos + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.kind === "event_received") {
          if (typeof obj.sequence === "number") state.seq = obj.sequence;
          continue;
        }
        writeStdout(obj);
      }
    });
    res.on("end", () => {});
    res.on("error", (err) => {
      writeStdout({ kind: "bridge_error", error: err.message, received_at: nowIso() });
    });
  });

  req.on("error", (err) => {
    dbg(`resume stream error: ${err.message}`);
    writeStdout({ kind: "bridge_error", error: err.message, received_at: nowIso() });
  });

  req.flushHeaders();
  state.req = req;
  return state;
}

async function cmdResume(args) {
  let sessionId = null, seqArg = null, tailTmp = false;
  for (const arg of args) {
    if (arg === "--tailtmp") tailTmp = true;
    else if (!sessionId) sessionId = arg;
    else if (!seqArg) seqArg = arg;
    else throw userError(`Unexpected argument: ${arg}`);
  }
  if (!sessionId) { console.error("Usage: directionally resume <session_id> [seq] [--tailtmp]"); process.exit(1); }
  const seq = seqArg ? (parseInt(seqArg, 10) || 0) : 0;

  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());

  if (!projectId) {
    writeStdout({ kind: "bridge_error", error: "no project_id found; run `directionally setup` first", received_at: nowIso() });
    process.exit(1);
  }

  let inputStream = process.stdin;

  if (tailTmp) {
    // Resume already knows the session_id — use it as the filename directly.
    const inputFile = path.join(process.env.TMPDIR || "/tmp", sessionId);
    fs.writeFileSync(inputFile, "", { flag: "a" });
    inputStream = createFileTailStream(inputFile);
  }

  const state = openResumeStream(sessionId, seq, projectId, apiBase);
  const startedMsg = { kind: "bridge_started", api_base: apiBase, project_id: projectId, session_id: sessionId, received_at: nowIso() };
  writeStdout(startedMsg);

  const rl = readline.createInterface({ input: inputStream, terminal: false });

  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      writeStdout({ kind: "bridge_error", error: "invalid JSON", line, received_at: nowIso() });
      return;
    }
    state.req.write(JSON.stringify(msg) + "\n");
  });

  rl.on("close", () => {
    try { state.req.end(); } catch { /* ignore */ }
    if (inputStream !== process.stdin) inputStream.destroy();
  });
}

async function cmdBridge(args) {
  let tailTmp = false;
  let subsessionId = null;
  let elaboration = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tailtmp") tailTmp = true;
    else if (arg === "--subsession-id") subsessionId = args[++i];
    else if (arg.startsWith("--subsession-id=")) subsessionId = arg.slice("--subsession-id=".length);
    else if (arg === "--elaboration") elaboration = args[++i];
    else if (arg.startsWith("--elaboration=")) elaboration = arg.slice("--elaboration=".length);
    else throw userError(`Unknown argument: ${arg}`);
  }

  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());

  if (!projectId) {
    writeStdout({ kind: "bridge_error", error: "no project_id found; run `directionally setup` first", received_at: nowIso() });
    process.exit(1);
  }

  let inputStream = process.stdin;

  if (tailTmp) {
    const inputName = `bridge_${randomBytes(6).toString("hex")}`;
    const inputFile = path.join(process.env.TMPDIR || "/tmp", inputName);
    fs.writeFileSync(inputFile, "", { flag: "a+" });
    _tailtmpInputFile = inputFile;
    inputStream = createFileTailStream(inputFile);
  } else {
    writeStdout({ kind: "bridge_started", api_base: apiBase, project_id: projectId, received_at: nowIso() });
  }

  const session = openBridgeStream(projectId, apiBase);

  if (subsessionId && elaboration) {
    const elab = JSON.stringify({ op: "elaborating", subsession_id: subsessionId, text: elaboration });
    dbg(`sending initial elaboration: ${elab}`);
    session.req.write(elab + "\n");
  }

  const rl = readline.createInterface({ input: inputStream, terminal: false });

  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      writeStdout({ kind: "bridge_error", error: "invalid JSON", line, received_at: nowIso() });
      return;
    }
    session.req.write(JSON.stringify(msg) + "\n");
  });

  rl.on("close", () => {
    try { session.req.end(); } catch { /* ignore */ }
    if (inputStream !== process.stdin) inputStream.destroy();
  });
}

// ---- setup ------------------------------------------------------------------

function parseGitHubRemote(url) {
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1], name: ssh[2] };
  const https_ = url.match(/^(?:https?:\/\/|ssh:\/\/git@|git:\/\/)?(?:[^@]+@)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (https_) return { owner: https_[1], name: https_[2] };
  return null;
}

function pickGitHubRepo(remotesOutput) {
  let origin = null, first = null;
  for (const line of remotesOutput.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((?:fetch|push)\)\s*$/);
    if (!m) continue;
    const [, name, url] = m;
    const repo = parseGitHubRemote(url);
    if (!repo) continue;
    if (name === "origin" && !origin) origin = { ...repo, remoteName: name, remoteUrl: url };
    if (!first) first = { ...repo, remoteName: name, remoteUrl: url };
  }
  return origin || first || null;
}

function writeIfChanged(filePath, content) {
  if (fs.existsSync(filePath)) {
    if (fs.readFileSync(filePath, "utf8") === content)
      return { path: filePath, action: "unchanged" };
    fs.writeFileSync(filePath, content, "utf8");
    return { path: filePath, action: "updated" };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return { path: filePath, action: "created" };
}

async function downloadSkill(url) {
  const res = await fetch(url, { headers: { "user-agent": userAgent() } });
  if (!res.ok) throw userError(`Could not download SKILL.md from ${url}: HTTP ${res.status}`);
  return res.text();
}

async function cmdSetup(args) {
  let cwd = process.cwd(), forcedId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd") { cwd = args[++i]; }
    else if (args[i].startsWith("--cwd=")) { cwd = args[i].slice(6); }
    else if (args[i] === "--force") { forcedId = args[++i]; }
    else if (args[i].startsWith("--force=")) { forcedId = args[i].slice(8); }
    else throw userError(`Unknown argument: ${args[i]}`);
  }

  const gitRoot = findGitRoot(cwd);
  const targetRoot = gitRoot || path.resolve(cwd);
  let projectId, projectSource;

  if (forcedId) {
    projectId = forcedId;
    projectSource = "--force";
  } else if (gitRoot) {
    const remotes = (() => { try { return execFileSync("git", ["-C", gitRoot, "remote", "-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } })();
    const repo = pickGitHubRepo(remotes);
    if (!repo) throw userError("Could not find a github.com remote. Use --force <owner/repo>.");
    projectId = `${repo.owner}/${repo.name}`;
    projectSource = `${repo.remoteName} ${repo.remoteUrl}`;
  } else {
    throw userError("Could not find a git root. Use --force <owner/repo>.");
  }

  const skillUrl = process.env.DIRECTIONALLY_SKILL_URL || DEFAULT_SKILL_URL;
  const skillBody = await downloadSkill(skillUrl);

  const files = [
    { ...writeIfChanged(path.join(targetRoot, SKILL_RELATIVE), skillBody), rel: SKILL_RELATIVE },
    { ...writeIfChanged(path.join(targetRoot, SKILL_CLAUDE_RELATIVE), skillBody), rel: SKILL_CLAUDE_RELATIVE },
    { ...writeIfChanged(path.join(targetRoot, PROJECT_ID_RELATIVE), `${projectId}\n`), rel: PROJECT_ID_RELATIVE },
  ];

  const lines = [`Project: ${projectId} (from ${projectSource})`, `Root: ${targetRoot}`, ""];
  for (const f of files) {
    lines.push(`  ${f.action.padEnd(9)} ${f.rel}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

// ---- append -----------------------------------------------------------------

function cmdAppend(args) {
  let name = null, ndjson = null;
  for (const arg of args) {
    if (!name) name = arg;
    else if (!ndjson) ndjson = arg;
    else throw userError(`Unexpected argument: ${arg}`);
  }
  if (!name || !ndjson) {
    console.error("Usage: directionally append <name> <ndjson>");
    process.exit(1);
  }
  try { JSON.parse(ndjson); } catch (e) { fail(`Invalid JSON: ${e.message}`); }
  const filePath = path.join(process.env.TMPDIR || "/tmp", name);
  fs.appendFileSync(filePath, ndjson.trim() + "\n");
}

// ---- SSE helpers (used by recall) ------------------------------------------

function parseSseEventBlock(block) {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || "message";
    if (field === "data") dataLines.push(value);
  }
  return { event, data: dataLines.join("\n") };
}

async function* sseEventsFromResponse(res) {
  if (!res.body) throw new Error("Response has no body stream.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sepIdx).replace(/\r/g, "").trim();
      buffer = buffer.slice(sepIdx + 2);
      if (raw) yield parseSseEventBlock(raw);
    }
  }
  const final = buffer.replace(/\r/g, "").trim();
  if (final) yield parseSseEventBlock(final);
}

function sessionIdFromStarted(obj) {
  if (!obj || typeof obj !== "object") return null;
  const sid = obj.session_id ?? obj.sessionId ?? obj.id ?? null;
  return typeof sid === "string" && sid.trim() ? sid.trim() : null;
}

function orderedUniqueCids(cids) {
  const seen = new Set();
  const out = [];
  for (const c of cids) {
    const cid = typeof c === "string" ? c.trim() : "";
    if (cid && !seen.has(cid)) { seen.add(cid); out.push(cid); }
  }
  return out;
}

async function apiFetchRecord(apiBase, cid, projectId) {
  const url = new URL(`${apiBase}/fetch/${encodeURIComponent(cid)}`);
  if (projectId) url.searchParams.set("project_id", projectId);
  const res = await fetch(url, {
    headers: { "accept": "application/json", "user-agent": userAgent() },
  });
  const text = await res.text();
  if (!res.ok) return { cid, fetch_error: `HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 500)}` : ""}` };
  let record;
  try { record = JSON.parse(text); } catch { record = { raw: text }; }
  return { cid, record };
}

async function postFeedback(apiBase, body) {
  const res = await fetch(`${apiBase}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json", "user-agent": userAgent() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ---- recall / follow_up / fetch / feedback / impact_note / outcome ----------

async function cmdRecall(problem) {
  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());
  const body = { problems: [problem] };
  if (projectId) body.project_id = projectId;

  const res = await fetch(`${apiBase}/post_many`, {
    method: "POST",
    headers: { "accept": "text/event-stream", "content-type": "application/json", "user-agent": userAgent() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`);
  }

  let sessionStarted = null, postEvent = null, sessionTimeout = null;
  const responses = [];
  for await (const ev of sseEventsFromResponse(res)) {
    if (ev.event === "session_started") { try { sessionStarted = JSON.parse(ev.data); } catch { /* ignore */ } }
    else if (ev.event === "post") { try { postEvent = JSON.parse(ev.data); } catch { /* ignore */ } }
    else if (ev.event === "response") { try { responses.push(JSON.parse(ev.data)); } catch { responses.push({ raw: ev.data }); } }
    else if (ev.event === "session_timeout") { try { sessionTimeout = JSON.parse(ev.data); } catch { sessionTimeout = { raw: ev.data }; } }
  }

  if (!postEvent || !Array.isArray(postEvent.items) || !postEvent.items.length) {
    throw new Error("Did not receive expected `post` event with `items[]`.");
  }
  const item = postEvent.items[0] || {};
  const matched_cids = orderedUniqueCids(
    responses.flatMap((r) => (Array.isArray(r.cids) ? r.cids : []))
  );
  const fetched_contents = matched_cids.length
    ? await Promise.all(matched_cids.map((cid) => apiFetchRecord(apiBase, cid, projectId)))
    : [];

  return {
    kind: "recall",
    session_id: sessionIdFromStarted(sessionStarted),
    project_id: projectId,
    cid: item.cid || null,
    matched_cids,
    fetched_contents,
    session_started: sessionStarted,
    responses,
    session_timeout: sessionTimeout,
  };
}

async function cmdFollowUp(cid, learning) {
  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());
  const url = new URL(`${apiBase}/follow_up/${encodeURIComponent(cid)}`);
  if (projectId) url.searchParams.set("project_id", projectId);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json", "user-agent": userAgent() },
    body: JSON.stringify({ residue: learning }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`);
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { kind: "follow_up", project_id: projectId, cid, learning, response: data };
}

async function cmdFetch(cid) {
  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());
  const got = await apiFetchRecord(apiBase, cid, projectId);
  if (got.fetch_error) throw new Error(got.fetch_error);
  return { kind: "fetch", project_id: projectId, cid: got.cid, record: got.record };
}

async function cmdFeedback(sessionId, matchedCid, rating, reason) {
  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());
  const sid = (sessionId || "").trim();
  const mc = (matchedCid || "").trim();
  if (!sid) throw userError("session_id must be a non-empty string.");
  if (!mc) throw userError("matched_cid must be a non-empty string.");
  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 0 || ratingNum > 10)
    throw userError(`Rating must be an integer 0–10, got: ${rating}`);
  const body = { subject: { type: "session", id: sid }, kind: "match_rating", payload: { rating: ratingNum, match_cid: mc, reason } };
  if (projectId) body.project_id = projectId;
  const data = await postFeedback(apiBase, body);
  return { kind: "feedback", project_id: projectId, session_id: sid, matched_cid: mc, rating: ratingNum, reason, response: data };
}

async function cmdImpactNote(sessionId, note) {
  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());
  const sid = (sessionId || "").trim();
  const text = (note || "").trim();
  if (!sid) throw userError("session_id must be a non-empty string.");
  if (!text) throw userError("Impact note must be a non-empty string.");
  const body = { subject: { type: "session", id: sid }, kind: "impact_note", payload: { text } };
  if (projectId) body.project_id = projectId;
  const data = await postFeedback(apiBase, body);
  return { kind: "impact_note", project_id: projectId, session_id: sid, note: text, response: data };
}

async function cmdOutcome(sessionId, outcome) {
  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());
  const sid = (sessionId || "").trim();
  const value = (outcome || "").trim();
  if (!sid) throw userError("session_id must be a non-empty string.");
  if (!OUTCOME_VALUES.has(value))
    throw userError(`Outcome must be one of: ${[...OUTCOME_VALUES].join(", ")}. Got: ${value}`);
  const body = { subject: { type: "session", id: sid }, kind: "session_outcome", payload: { outcome: value } };
  if (projectId) body.project_id = projectId;
  const data = await postFeedback(apiBase, body);
  return { kind: "outcome", project_id: projectId, session_id: sid, outcome: value, response: data };
}

// ---- usage ------------------------------------------------------------------

function usage(code = 0) {
  const msg = [
    "Usage:",
    "  directionally bridge [--tailtmp] [--subsession-id <id>] [--elaboration <text>]",
    "  directionally resume <session_id> [seq] [--tailtmp]",
    "  directionally append <name> <ndjson>",
    "  directionally recall \"<problem statement>\"",
    "  directionally follow_up <cid> \"<learning>\"",
    "  directionally fetch <cid>",
    "  directionally feedback <session_id> <matched_cid> <0..10> \"<reason>\"",
    "  directionally impact_note <session_id> \"<note>\"",
    "  directionally outcome <session_id> helped_direction|helped_implementation|irrelevant|missing_memory",
    "  directionally setup [--cwd <path>] [--force <owner/repo>]",
    "",
    "Env:",
    `  DIRECTIONALLY_API_BASE   Override API base URL (default: ${DEFAULT_API_BASE})`,
    "  DIRECTIONALLY_SKILL_URL  Override SKILL.md source URL used by setup",
  ].join("\n");
  (code === 0 ? console.log : console.error)(msg);
  process.exit(code);
}

// ---- main -------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") usage(0);

  try {
    if (cmd === "bridge") { await cmdBridge(rest); return; }
    if (cmd === "resume") { await cmdResume(rest); return; }
    if (cmd === "append") { cmdAppend(rest); return; }
    if (cmd === "recall") {
      const problem = rest[0];
      if (!problem) usage(1);
      process.stdout.write(JSON.stringify(await cmdRecall(problem)) + "\n");
      return;
    }
    if (cmd === "follow_up") {
      const [cid, learning] = rest;
      if (!cid || !learning) usage(1);
      process.stdout.write(JSON.stringify(await cmdFollowUp(cid, learning)) + "\n");
      return;
    }
    if (cmd === "fetch") {
      const cid = rest[0];
      if (!cid) usage(1);
      process.stdout.write(JSON.stringify(await cmdFetch(cid)) + "\n");
      return;
    }
    if (cmd === "feedback") {
      const [sessionId, matchedCid, rating, reason] = rest;
      if (!sessionId || !matchedCid || rating === undefined || !reason) usage(1);
      process.stdout.write(JSON.stringify(await cmdFeedback(sessionId, matchedCid, rating, reason)) + "\n");
      return;
    }
    if (cmd === "impact_note") {
      const [sessionId, note] = rest;
      if (!sessionId || !note) usage(1);
      process.stdout.write(JSON.stringify(await cmdImpactNote(sessionId, note)) + "\n");
      return;
    }
    if (cmd === "outcome") {
      const [sessionId, outcome] = rest;
      if (!sessionId || !outcome) usage(1);
      process.stdout.write(JSON.stringify(await cmdOutcome(sessionId, outcome)) + "\n");
      return;
    }
    if (cmd === "setup") { await cmdSetup(rest); return; }
    usage(1);
  } catch (err) {
    if (err && err.userFacing) fail(err.message);
    else fail(err && err.stack ? err.stack : String(err));
  }
}

main();
