#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function readOwnVersion() {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readOwnVersion();
const DEFAULT_API_BASE = "https://api.schelling.sh";

function usage(exitCode = 0) {
  const msg = [
    "Usage:",
    '  schelling recall "<problem statement>"',
    '  schelling follow_up "<cid>" "<learning>"',
    '  schelling fetch "<cid>"',
    "  schelling feedback <session_id> <matched_cid> <0..10> \"<textual feedback>\"",
    "  schelling setup [--cwd <path>] [--force <project-id>]",
    "",
    "Env:",
    `  SCHELLING_API_BASE   Override API base URL (default: ${DEFAULT_API_BASE})`,
    `  SCHELLING_SKILL_URL  Override SKILL.md source URL used by \`setup\``,
    "",
    "Output:",
    "  JSON to stdout. Errors go to stderr and exit non-zero."
  ].join("\n");
  if (exitCode === 0) console.log(msg);
  else console.error(msg);
  process.exit(exitCode);
}

function fail(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

function getApiBase() {
  return (process.env.SCHELLING_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function userAgent() {
  return `schelling/${VERSION}`;
}

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

  const data = dataLines.join("\n");
  return { event, data };
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
      const rawBlock = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      const trimmed = rawBlock.replace(/\r/g, "").trim();
      if (!trimmed) continue;
      yield parseSseEventBlock(trimmed);
    }
  }

  const final = buffer.replace(/\r/g, "").trim();
  if (final) yield parseSseEventBlock(final);
}

function sessionIdFromStarted(sessionStarted) {
  if (!sessionStarted || typeof sessionStarted !== "object") return null;
  const sid =
    sessionStarted.session_id ??
    sessionStarted.sessionId ??
    sessionStarted.id ??
    null;
  return typeof sid === "string" && sid.trim() ? sid.trim() : null;
}

function orderedUniqueCids(cids) {
  const seen = new Set();
  const out = [];
  for (const c of cids) {
    const cid = typeof c === "string" ? c.trim() : "";
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    out.push(cid);
  }
  return out;
}

function matchedCidsFromRecall(responses) {
  const ordered = [];
  if (Array.isArray(responses)) {
    for (const r of responses) {
      if (!r || typeof r !== "object" || !Array.isArray(r.cids)) continue;
      for (const cid of r.cids) ordered.push(cid);
    }
  }
  return orderedUniqueCids(ordered);
}

async function apiFetchRecord(apiBase, cid, projectId) {
  const url = new URL(`${apiBase}/fetch/${encodeURIComponent(cid)}`);
  if (projectId) url.searchParams.set("project_id", projectId);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "accept": "application/json",
      "user-agent": userAgent()
    }
  });

  const text = await res.text();
  if (!res.ok) {
    const snippet = text ? `: ${text.slice(0, 500)}${text.length > 500 ? "…" : ""}` : "";
    return {
      cid,
      fetch_error: `HTTP ${res.status} ${res.statusText}${snippet}`
    };
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    record = { raw: text };
  }
  return { cid, record };
}

async function cmdRecall(problem) {
  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());

  const requestBody = { problems: [problem] };
  if (projectId) requestBody.project_id = projectId;

  const res = await fetch(`${apiBase}/post_many`, {
    method: "POST",
    headers: {
      "accept": "text/event-stream",
      "content-type": "application/json",
      "user-agent": userAgent()
    },
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`);
  }

  let sessionStarted = null;
  let postEvent = null;
  const responses = [];
  let sessionTimeout = null;
  const rawEvents = [];

  for await (const ev of sseEventsFromResponse(res)) {
    rawEvents.push(ev);
    if (ev.event === "session_started") {
      try { sessionStarted = JSON.parse(ev.data); } catch { /* ignore */ }
      continue;
    }
    if (ev.event === "post") {
      try { postEvent = JSON.parse(ev.data); } catch { /* ignore */ }
      continue;
    }
    if (ev.event === "response") {
      try { responses.push(JSON.parse(ev.data)); } catch { responses.push({ raw: ev.data }); }
      continue;
    }
    if (ev.event === "session_timeout") {
      try { sessionTimeout = JSON.parse(ev.data); } catch { sessionTimeout = { raw: ev.data }; }
    }
  }

  if (!postEvent || !Array.isArray(postEvent.items) || postEvent.items.length === 0) {
    throw new Error("Did not receive expected `post` event with `items[]`.");
  }

  const item = postEvent.items[0] || {};
  const matched_cids = matchedCidsFromRecall(responses);
  const session_id = sessionIdFromStarted(sessionStarted);

  const fetched_contents =
    matched_cids.length === 0 ?
      [] :
      await Promise.all(matched_cids.map((cid) => apiFetchRecord(apiBase, cid, projectId)));

  return {
    kind: "recall",
    session_id,
    project_id: projectId,
    cid: item.cid || null,
    matched_cids,
    fetched_contents,
    session_started: sessionStarted,
    responses,
    session_timeout: sessionTimeout
  };
}

async function cmdFollowUp(cid, learning) {
  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());
  const url = new URL(`${apiBase}/follow_up/${encodeURIComponent(cid)}`);
  if (projectId) url.searchParams.set("project_id", projectId);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "user-agent": userAgent()
    },
    body: JSON.stringify({ residue: learning })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`);

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  return { kind: "follow_up", project_id: projectId, cid, learning, response: data };
}

async function cmdFeedback(sessionId, matchedCid, rating, text) {
  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());

  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 0 || ratingNum > 10) {
    throw userError(`Rating must be an integer between 0 and 10, got: ${rating}`);
  }

  const body = { session_id: sessionId, matched_cid: matchedCid, rating: ratingNum, feedback: text };
  if (projectId) body.project_id = projectId;

  const res = await fetch(`${apiBase}/feedback`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "user-agent": userAgent()
    },
    body: JSON.stringify(body)
  });

  const responseText = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}${responseText ? `\n${responseText}` : ""}`);

  let data;
  try { data = JSON.parse(responseText); } catch { data = { raw: responseText }; }

  return { kind: "feedback", project_id: projectId, session_id: sessionId, matched_cid: matchedCid, rating: ratingNum, feedback: text, response: data };
}

async function cmdFetch(cid) {
  const apiBase = getApiBase();
  const projectId = getProjectId(process.cwd());
  const got = await apiFetchRecord(apiBase, cid, projectId);
  if (got.fetch_error) throw new Error(got.fetch_error);
  return { kind: "fetch", project_id: projectId, cid: got.cid, record: got.record };
}

function findGitRoot(startDir) {
  // Ask git itself rather than walking the tree: this handles subdirs,
  // worktrees, and submodules correctly, and matches whatever git on the
  // user's machine considers the repo root.
  try {
    const out = execFileSync(
      "git",
      ["-C", startDir, "rev-parse", "--is-inside-work-tree", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines[0] !== "true") return null;
    return lines[1] || null;
  } catch {
    return null;
  }
}

function parseGitHubRemote(remoteUrl) {
  if (!remoteUrl) return null;

  // Supported forms:
  //   git@github.com:owner/repo(.git)
  //   https://github.com/owner/repo(.git)
  //   ssh://git@github.com/owner/repo(.git)
  //   github.com/owner/repo
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) return { host: "github.com", owner: sshMatch[1], name: sshMatch[2] };

  const urlMatch = remoteUrl.match(
    /^(?:https?:\/\/|ssh:\/\/git@|git:\/\/)?(?:[^@]+@)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
  );
  if (urlMatch) return { host: "github.com", owner: urlMatch[1], name: urlMatch[2] };

  return null;
}

function gitRemotesAll(repoRoot) {
  try {
    return execFileSync("git", ["-C", repoRoot, "remote", "-v"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return "";
  }
}

function pickGitHubRepo(remotesOutput) {
  // `git remote -v` looks like:
  //   origin   git@github.com:foo/bar.git (fetch)
  //   origin   git@github.com:foo/bar.git (push)
  //   upstream https://github.com/up/bar.git (fetch)
  // Prefer `origin`; fall back to the first GitHub remote we see.
  let originMatch = null;
  let firstGithub = null;

  for (const line of remotesOutput.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^(\S+)\s+(\S+)\s+\((?:fetch|push)\)\s*$/);
    if (!m) continue;
    const [, name, url] = m;
    const repo = parseGitHubRemote(url);
    if (!repo) continue;
    if (name === "origin" && !originMatch) originMatch = { ...repo, remoteName: name, remoteUrl: url };
    if (!firstGithub) firstGithub = { ...repo, remoteName: name, remoteUrl: url };
  }

  return originMatch || firstGithub || null;
}

const SKILL_RELATIVE = path.join(".agents", "skills", "schelling", "SKILL.md");
const SKILL_CLAUDE_RELATIVE = path.join(".claude", "skills", "schelling", "SKILL.md");
const PROJECT_ID_RELATIVE = path.join(".schelling", "project-id");
const DEFAULT_SKILL_URL =
  "https://raw.githubusercontent.com/schellingsh/skill/refs/heads/main/.agents/skills/schelling/SKILL.md";

function isDirectory(absPath) {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function findSchellingRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, PROJECT_ID_RELATIVE))) return dir;

    const hasAgents = isDirectory(path.join(dir, ".agents"));
    const hasSchelling = isDirectory(path.join(dir, ".schelling"));
    if (hasAgents && hasSchelling) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findProjectRoot(startDir) {
  return findGitRoot(startDir) || findSchellingRoot(startDir);
}

function readProjectIdFile(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, PROJECT_ID_RELATIVE), "utf8");
    const id = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
    return id || null;
  } catch {
    return null;
  }
}

function getProjectId(startDir) {
  const rootDir = findProjectRoot(startDir);
  if (!rootDir) return null;
  return readProjectIdFile(rootDir);
}

function getSkillUrl() {
  return process.env.SCHELLING_SKILL_URL || DEFAULT_SKILL_URL;
}

async function downloadSkill(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        "accept": "text/markdown, text/plain;q=0.9, */*;q=0.8",
        "user-agent": userAgent()
      }
    });
  } catch (err) {
    throw userError(`Could not download SKILL.md from ${url}: ${err && err.message ? err.message : err}`);
  }
  if (!res.ok) {
    throw userError(`Could not download SKILL.md from ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function writeIfChanged(filePath, nextContent) {
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, "utf8");
    if (current === nextContent) return { path: filePath, changed: false, action: "unchanged" };
    fs.writeFileSync(filePath, nextContent, "utf8");
    return { path: filePath, changed: true, action: "updated" };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextContent, "utf8");
  return { path: filePath, changed: true, action: "created" };
}

function userError(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

function parseSetupArgs(args) {
  const opts = { cwd: process.cwd(), forcedProjectId: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--cwd") {
      const v = args[i + 1];
      if (!v) throw userError("`--cwd` requires a path argument.");
      opts.cwd = v;
      i += 1;
    } else if (a.startsWith("--cwd=")) {
      opts.cwd = a.slice("--cwd=".length);
    } else if (a === "--force") {
      const v = args[i + 1];
      if (!v) throw userError("`--force` requires a `<project-id>` like `owner/repo`.");
      opts.forcedProjectId = v;
      i += 1;
    } else if (a.startsWith("--force=")) {
      opts.forcedProjectId = a.slice("--force=".length);
    } else {
      throw userError(`Unknown argument for \`setup\`: ${a}`);
    }
  }
  return opts;
}

function normalizeProjectId(projectId) {
  const id = typeof projectId === "string" ? projectId.trim() : "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(id)) {
    throw userError(`Invalid project id \`${projectId}\`. Expected \`owner/repo\`.`);
  }
  return id;
}

async function cmdSetup(args) {
  const opts = parseSetupArgs(args);
  const gitRoot = findGitRoot(opts.cwd);
  const schellingRoot = findSchellingRoot(opts.cwd);
  const targetRoot = gitRoot || schellingRoot || path.resolve(opts.cwd);

  let projectId;
  let projectSource;
  let detectedRepo = null;
  if (opts.forcedProjectId) {
    projectId = normalizeProjectId(opts.forcedProjectId);
    projectSource = "--force";
  } else if (gitRoot) {
    const remotes = gitRemotesAll(gitRoot);
    const repo = pickGitHubRepo(remotes);
    if (!repo) {
      throw userError(
        `Could not find a github.com remote in \`git remote -v\` for ${gitRoot}.\n` +
          "Add one with e.g. `git remote add origin git@github.com:<owner>/<repo>.git`, or re-run with `schelling setup --force <owner/repo>`."
      );
    }
    detectedRepo = repo;
    projectId = `${repo.owner}/${repo.name}`;
    projectSource = `${repo.remoteName} ${repo.remoteUrl}`;
  } else if (schellingRoot) {
    projectId = readProjectIdFile(schellingRoot);
    if (!projectId) {
      throw userError(
        `Found an existing Schelling root at ${schellingRoot}, but ${PROJECT_ID_RELATIVE} is missing or empty.\n` +
          "Re-run with `schelling setup --force <owner/repo>` to set it explicitly."
      );
    }
    projectSource = `existing ${PROJECT_ID_RELATIVE}`;
  } else {
    throw userError(
      "Could not find a git root or existing Schelling root.\n" +
        "Run `schelling setup --force <owner/repo>` to initialize the current directory explicitly."
    );
  }

  const skillUrl = getSkillUrl();
  const skillBody = await downloadSkill(skillUrl);

  const skillAbs = path.join(targetRoot, SKILL_RELATIVE);
  const skillClaudeAbs = path.join(targetRoot, SKILL_CLAUDE_RELATIVE);
  const projectIdAbs = path.join(targetRoot, PROJECT_ID_RELATIVE);

  const files = [
    { ...writeIfChanged(skillAbs, skillBody), relpath: SKILL_RELATIVE },
    { ...writeIfChanged(skillClaudeAbs, skillBody), relpath: SKILL_CLAUDE_RELATIVE },
    { ...writeIfChanged(projectIdAbs, `${projectId}\n`), relpath: PROJECT_ID_RELATIVE }
  ];

  const lines = [
    detectedRepo ?
      `Detected project: ${projectId} (from ${projectSource})` :
      `Using project: ${projectId} (from ${projectSource})`,
    `Target root: ${targetRoot}`,
    ""
  ];
  for (const f of files) {
    const verb =
      f.action === "created" ? "Created  " :
      f.action === "updated" ? "Updated  " :
      "Unchanged";
    lines.push(`  ${verb} ${f.relpath}`);
  }
  if (files.some((f) => f.changed)) {
    lines.push("");
    lines.push("Add, commit, and push these files following your repo's normal contribution policy.");
  }
  lines.push("");
  lines.push("Review what your agents store and recall at https://schelling.sh");

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") usage(0);

  try {
    if (cmd === "recall") {
      const problem = args[1];
      if (!problem) usage(1);
      const out = await cmdRecall(problem);
      process.stdout.write(JSON.stringify(out) + "\n");
      return;
    }

    if (cmd === "follow_up") {
      const cid = args[1];
      const learning = args[2];
      if (!cid || !learning) usage(1);
      const out = await cmdFollowUp(cid, learning);
      process.stdout.write(JSON.stringify(out) + "\n");
      return;
    }

    if (cmd === "fetch") {
      const cid = args[1];
      if (!cid) usage(1);
      const out = await cmdFetch(cid);
      process.stdout.write(JSON.stringify(out) + "\n");
      return;
    }

    if (cmd === "feedback") {
      const [sessionId, matchedCid, rating, text] = args.slice(1);
      if (!sessionId || !matchedCid || rating === undefined || !text) usage(1);
      const out = await cmdFeedback(sessionId, matchedCid, rating, text);
      process.stdout.write(JSON.stringify(out) + "\n");
      return;
    }

    if (cmd === "setup") {
      // `setup` is human-run, not piped. It writes a plain-text success
      // message directly to stdout instead of JSON like the other commands.
      await cmdSetup(args.slice(1));
      return;
    }

    usage(1);
  } catch (err) {
    if (err && err.userFacing) fail(err.message);
    else fail(err && err.stack ? err.stack : String(err));
  }
}

main();
