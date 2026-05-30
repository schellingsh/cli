#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const http = require("node:http");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

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
  "https://raw.githubusercontent.com/schellingsh/skill/refs/heads/main/.agents/skills/directionally/SKILL.md";

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

// subsession_id -> { req, sessionId, seq }
const activeSessions = new Map();

function openSessionStream(subsessionId, projectId, apiBase) {
  writeStdout({ kind: "subsession_create", subsession_id: subsessionId, received_at: nowIso() });

  const parts = urlParts(apiBase, `/sessions/${encodeURIComponent(projectId)}`);
  const mod = pickModule(apiBase);
  const state = { req: null, sessionId: null, seq: 0 };
  activeSessions.set(subsessionId, state);

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

        // Consume event_received silently — used only for seq tracking
        if (obj.kind === "event_received") {
          if (typeof obj.sequence === "number") state.seq = obj.sequence;
          continue;
        }

        if (obj.kind === "session_started") {
          state.sessionId = obj.session_id;
        }

        writeStdout(obj);
      }
    });
    res.on("end", () => { activeSessions.delete(subsessionId); });
    res.on("error", (err) => {
      writeStdout({ kind: "bridge_error", error: err.message, received_at: nowIso() });
      activeSessions.delete(subsessionId);
    });
  });

  req.on("error", (err) => {
    writeStdout({ kind: "bridge_error", error: err.message, received_at: nowIso() });
    activeSessions.delete(subsessionId);
  });

  state.req = req;
  return state;
}


function handleBridgeOp(msg, projectId, apiBase) {
  const { op, subsession_id: sid } = msg;

  if (!sid) {
    writeStdout({ kind: "bridge_error", error: `${op} requires subsession_id`, received_at: nowIso() });
    return;
  }

  let state = activeSessions.get(sid);
  if (!state) state = openSessionStream(sid, projectId, apiBase);
  state.req.write(JSON.stringify(msg) + "\n");
}

function openResumeStream(sessionId, seq, projectId, apiBase) {
  const parts = urlParts(apiBase, `/session/resume/${encodeURIComponent(sessionId)}?after=${seq}`);
  const mod = pickModule(apiBase);
  const state = { req: null, sessionId, seq };

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
    writeStdout({ kind: "bridge_error", error: err.message, received_at: nowIso() });
  });

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

  let inputFile = null;
  let inputStream = process.stdin;

  if (tailTmp) {
    inputFile = path.join(process.env.TMPDIR || "/tmp", "bridge_in");
    fs.writeFileSync(inputFile, "", { flag: "a" });
    inputStream = createFileTailStream(inputFile);
  }

  const state = openResumeStream(sessionId, seq, projectId, apiBase);
  const startedMsg = { kind: "bridge_started", api_base: apiBase, project_id: projectId, session_id: sessionId, received_at: nowIso() };
  if (inputFile) startedMsg.input_file = inputFile;
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
  for (const arg of args) {
    if (arg === "--tailtmp") tailTmp = true;
    else throw userError(`Unknown argument: ${arg}`);
  }

  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());

  if (!projectId) {
    writeStdout({ kind: "bridge_error", error: "no project_id found; run `directionally setup` first", received_at: nowIso() });
    process.exit(1);
  }

  let inputFile = null;
  let inputStream = process.stdin;

  if (tailTmp) {
    inputFile = path.join(process.env.TMPDIR || "/tmp", "bridge_in");
    fs.writeFileSync(inputFile, "", { flag: "a" });
    inputStream = createFileTailStream(inputFile);
  }

  const startedMsg = { kind: "bridge_started", api_base: apiBase, project_id: projectId, received_at: nowIso() };
  if (inputFile) startedMsg.input_file = inputFile;
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
    handleBridgeOp(msg, projectId, apiBase);
  });

  rl.on("close", () => {
    for (const [, state] of activeSessions) {
      try { state.req.end(); } catch { /* ignore */ }
    }
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

// ---- usage ------------------------------------------------------------------

function usage(code = 0) {
  const msg = [
    "Usage:",
    "  directionally bridge [--tailtmp]",
    "  directionally resume <session_id> [seq] [--tailtmp]",
    "  directionally append <name> <ndjson>",
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
    if (cmd === "setup") { await cmdSetup(rest); return; }
    usage(1);
  } catch (err) {
    if (err && err.userFacing) fail(err.message);
    else fail(err && err.stack ? err.stack : String(err));
  }
}

main();
