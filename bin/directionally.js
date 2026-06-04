#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const http = require("node:http");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

function readOwnVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readOwnVersion();
const DEFAULT_API_BASE = "https://api.directionally.ai";
const PROJECT_ID_RELATIVE = path.join(".schelling", "project-id");
const SKILL_RELATIVE = path.join(".agents", "skills", "directionally", "SKILL.md");
const SKILL_CLAUDE_RELATIVE = path.join(".claude", "skills", "directionally", "SKILL.md");
const DEFAULT_SKILL_URL =
  "https://raw.githubusercontent.com/schellingsh/skill/refs/heads/main/.agents/skills/directionally/SKILL.md";

function getApiBase() {
  return (process.env.DIRECTIONALLY_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function userAgent() {
  return `directionally/${VERSION}`;
}

function nowIso() {
  return new Date().toISOString();
}

function userError(message) {
  const err = new Error(message);
  err.userFacing = true;
  return err;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function writeNdjson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) throw userError(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).replace(/-/g, "_");
    if (!key) throw userError(`Invalid flag: ${arg}`);
    if (eq !== -1) {
      flags[key] = arg.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function numberFlag(value, fallback, name) {
  if (value === undefined || value === true || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw userError(`${name} must be a non-negative integer.`);
  return n;
}

function findGitRoot(startDir) {
  try {
    const out = execFileSync(
      "git",
      ["-C", startDir, "rev-parse", "--is-inside-work-tree", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines[0] === "true" ? lines[1] || null : null;
  } catch {
    return null;
  }
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
    return raw.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

function requireProjectId() {
  const projectId = getProjectId(process.cwd());
  if (!projectId) throw userError("no project_id found; run `directionally --setup` first");
  return projectId;
}

function parseGitHubRemote(url) {
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1], name: ssh[2] };
  const https_ = url.match(/^(?:https?:\/\/|ssh:\/\/git@|git:\/\/)?(?:[^@]+@)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (https_) return { owner: https_[1], name: https_[2] };
  return null;
}

function pickGitHubRepo(remotesOutput) {
  let origin = null;
  let first = null;
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
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
    return { path: filePath, action: "unchanged" };
  }
  const existed = fs.existsSync(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return { path: filePath, action: existed ? "updated" : "created" };
}

async function downloadSkill(url) {
  const res = await fetch(url, { headers: { "user-agent": userAgent() } });
  if (!res.ok) throw userError(`Could not download SKILL.md from ${url}: HTTP ${res.status}`);
  return res.text();
}

async function cmdSetup(flags) {
  const cwd = flags.cwd && flags.cwd !== true ? String(flags.cwd) : process.cwd();
  const forcedId = flags.force && flags.force !== true ? String(flags.force) : null;
  const gitRoot = findGitRoot(cwd);
  const targetRoot = gitRoot || path.resolve(cwd);
  let projectId;
  let projectSource;

  if (forcedId) {
    projectId = forcedId;
    projectSource = "--force";
  } else if (gitRoot) {
    const remotes = (() => {
      try {
        return execFileSync("git", ["-C", gitRoot, "remote", "-v"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        return "";
      }
    })();
    const repo = pickGitHubRepo(remotes);
    if (!repo) throw userError("Could not find a github.com remote. Use --force <owner/repo>.");
    projectId = `${repo.owner}/${repo.name}`;
    projectSource = `${repo.remoteName} ${repo.remoteUrl}`;
  } else {
    throw userError("Could not find a git root. Use --force <owner/repo>.");
  }

  const skillBody = await downloadSkill(process.env.DIRECTIONALLY_SKILL_URL || DEFAULT_SKILL_URL);
  const files = [
    { ...writeIfChanged(path.join(targetRoot, SKILL_RELATIVE), skillBody), rel: SKILL_RELATIVE },
    { ...writeIfChanged(path.join(targetRoot, SKILL_CLAUDE_RELATIVE), skillBody), rel: SKILL_CLAUDE_RELATIVE },
    { ...writeIfChanged(path.join(targetRoot, PROJECT_ID_RELATIVE), `${projectId}\n`), rel: PROJECT_ID_RELATIVE },
  ];

  const lines = [`Project: ${projectId} (from ${projectSource})`, `Root: ${targetRoot}`, ""];
  for (const file of files) lines.push(`  ${file.action.padEnd(9)} ${file.rel}`);
  process.stdout.write(lines.join("\n") + "\n");
}

function openFirstSession(projectId, apiBase, initialMessage) {
  const url = new URL(`${apiBase}/sessions/${encodeURIComponent(projectId)}`);
  const mod = url.protocol === "https:" ? https : http;
  const state = { sequence: 0, sessionId: null };
  let sawHttpError = false;

  const req = mod.request({
    hostname: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    path: url.pathname + url.search,
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
    if (res.statusCode < 200 || res.statusCode >= 300) {
      sawHttpError = true;
      res.on("data", (chunk) => { buf += chunk; });
      res.on("end", () => {
        writeNdjson({
          kind: "bridge_error",
          error: `HTTP ${res.statusCode} ${res.statusMessage || ""}${buf ? `: ${buf.slice(0, 500)}` : ""}`,
          received_at: nowIso(),
        });
        process.exitCode = 1;
      });
      return;
    }
    res.on("data", (chunk) => {
      buf += chunk;
      let pos;
      while ((pos = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, pos).trim();
        buf = buf.slice(pos + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.kind === "event_received" && typeof obj.sequence === "number") {
          state.sequence = obj.sequence;
          continue;
        }
        if (obj.kind === "session_started") {
          state.sessionId = obj.session_id;
          writeNdjson({
            kind: "bridge_started",
            api_base: apiBase,
            project_id: projectId,
            session_id: obj.session_id,
            sequence: state.sequence,
            received_at: nowIso(),
          });
        }
        writeNdjson(obj);
      }
    });
    res.on("error", (err) => {
      writeNdjson({ kind: "bridge_error", error: err.message, received_at: nowIso() });
    });
    res.on("end", () => {
      if (!state.sessionId && !sawHttpError) {
        writeNdjson({
          kind: "bridge_error",
          error: "session stream ended before session_started",
          received_at: nowIso(),
        });
        process.exitCode = 1;
      }
    });
  });

  req.on("error", (err) => {
    writeNdjson({ kind: "bridge_error", error: err.message, received_at: nowIso() });
  });

  req.flushHeaders();
  if (initialMessage) req.write(JSON.stringify(initialMessage) + "\n");

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      writeNdjson({ kind: "bridge_error", error: "invalid JSON", line, received_at: nowIso() });
      return;
    }
    req.write(JSON.stringify(msg) + "\n");
  });

  rl.on("close", () => {
    req.end();
  });

  if (process.stdin.isTTY) req.end();
}

async function pollSession(projectId, apiBase, flags) {
  const sessionId = flags.session && flags.session !== true ? String(flags.session).trim() : "";
  if (!sessionId) throw userError("--session requires a session id.");
  const after = numberFlag(flags.after, 0, "--after");
  const wait = numberFlag(flags.wait, 30, "--wait");
  const limit = numberFlag(flags.limit, 100, "--limit");

  const url = new URL(
    `${apiBase}/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/events.ndjson`
  );
  url.searchParams.set("after", String(after));
  url.searchParams.set("wait", String(wait));
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url, {
    headers: { "accept": "application/x-ndjson", "user-agent": userAgent() },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`);
  if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function usage(code = 0) {
  const msg = [
    "Usage:",
    "  directionally --setup [--cwd <path>] [--force <owner/repo>]",
    "  directionally --first --subsession-id <id> --elaboration <text>",
    "  directionally --session <session_id> [--after <seq>] [--wait <secs>] [--limit <n>]",
    "",
    "Env:",
    `  DIRECTIONALLY_API_BASE   Override API base URL (default: ${DEFAULT_API_BASE})`,
    "  DIRECTIONALLY_SKILL_URL  Override SKILL.md source URL used by --setup",
  ].join("\n");
  (code === 0 ? console.log : console.error)(msg);
  process.exit(code);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "-h" || args[0] === "--help" || args[0] === "help") usage(0);

  try {
    const flags = parseArgs(args);
    if (flags.setup) {
      await cmdSetup(flags);
      return;
    }

    const apiBase = getApiBase();
    const projectId = requireProjectId();

    if (flags.first) {
      const subsessionId = flags.subsession_id && flags.subsession_id !== true ? String(flags.subsession_id) : null;
      const elaboration = flags.elaboration && flags.elaboration !== true ? String(flags.elaboration) : null;
      const initialMessage = subsessionId && elaboration
        ? { op: "elaborating", subsession_id: subsessionId, text: elaboration }
        : null;
      openFirstSession(projectId, apiBase, initialMessage);
      return;
    }

    if (flags.session) {
      await pollSession(projectId, apiBase, flags);
      return;
    }

    usage(1);
  } catch (err) {
    if (err && err.userFacing) fail(err.message);
    fail(err && err.stack ? err.stack : String(err));
  }
}

main();
