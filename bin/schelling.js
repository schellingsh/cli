#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");

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
    "",
    "Env:",
    `  SCHELLING_API_BASE   Override API base URL (default: ${DEFAULT_API_BASE})`,
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

function normalizeSimilarCases(similarCases) {
  if (!Array.isArray(similarCases)) return [];

  return similarCases
    .map((sc) => {
      if (typeof sc === "string") return { cid: sc, hint: null, problem: null };
      if (sc && typeof sc === "object") {
        return {
          cid: sc.cid || sc.id || null,
          hint: sc.hint || sc.relevance || sc.reason || null,
          problem: sc.problem || sc.title || sc.text || null
        };
      }
      return null;
    })
    .filter((x) => x && x.cid);
}

async function cmdRecall(problem) {
  const apiBase = getApiBase();
  const res = await fetch(`${apiBase}/post_many`, {
    method: "POST",
    headers: {
      "accept": "text/event-stream",
      "content-type": "application/json",
      "user-agent": userAgent()
    },
    body: JSON.stringify({ problems: [problem] })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`);
  }

  let sessionStarted = null;
  let postEvent = null;
  const rawEvents = [];

  for await (const ev of sseEventsFromResponse(res)) {
    rawEvents.push(ev);
    if (ev.event === "session_started") {
      try { sessionStarted = JSON.parse(ev.data); } catch { /* ignore */ }
    }
    if (ev.event === "post") {
      try {
        postEvent = JSON.parse(ev.data);
        break;
      } catch { /* ignore */ }
    }
  }

  if (!postEvent || !Array.isArray(postEvent.items) || postEvent.items.length === 0) {
    throw new Error("Did not receive expected `post` event with `items[]`.");
  }

  const item = postEvent.items[0] || {};
  return {
    kind: "recall",
    problem,
    cid: item.cid || null,
    classification: item.classification ?? null,
    default_path: item.default_path ?? null,
    risks: Array.isArray(item.risks) ? item.risks : [],
    similar_cases: normalizeSimilarCases(item.similar_cases)
  };
}

async function cmdFollowUp(cid, learning) {
  const apiBase = getApiBase();
  const res = await fetch(`${apiBase}/follow_up/${encodeURIComponent(cid)}`, {
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

  return { kind: "follow_up", cid, learning, response: data };
}

async function cmdFetch(cid) {
  const apiBase = getApiBase();
  const res = await fetch(`${apiBase}/fetch/${encodeURIComponent(cid)}`, {
    method: "GET",
    headers: {
      "accept": "application/json",
      "user-agent": userAgent()
    }
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`);

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  return { kind: "fetch", cid, record: data };
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

    usage(1);
  } catch (err) {
    fail(err && err.stack ? err.stack : String(err));
  }
}

main();
