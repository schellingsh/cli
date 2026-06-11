#!/usr/bin/env python3
"""Directionally agent session client."""

import http.client
import json
import os
import random
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

VERSION = "0.2.6"
DEFAULT_API_BASE = "https://api.directionally.ai"
PROJECT_ID_RELATIVE = os.path.join(".schelling", "project-id")
SKILL_RELATIVE = os.path.join(".agents", "skills", "directionally", "SKILL.md")
SKILL_CLAUDE_RELATIVE = os.path.join(".claude", "skills", "directionally", "SKILL.md")
DEFAULT_SKILL_URL = (
    "https://raw.githubusercontent.com/schellingsh/skill/refs/heads/main"
    "/.agents/skills/directionally/SKILL.md"
)


def get_api_base():
    return os.environ.get("DIRECTIONALLY_API_BASE", DEFAULT_API_BASE).rstrip("/")


def user_agent():
    return f"directionally/{VERSION}"


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_ndjson(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(message, code=1):
    sys.stderr.write(message + "\n")
    sys.exit(code)


def parse_args(args):
    flags = {"_": []}
    i = 0
    while i < len(args):
        arg = args[i]
        if not arg.startswith("--"):
            flags["_"].append(arg)
            i += 1
            continue
        if "=" in arg:
            key, val = arg[2:].split("=", 1)
            flags[key.replace("-", "_")] = val
        else:
            key = arg[2:].replace("-", "_")
            if not key:
                raise ValueError(f"Invalid flag: {arg}")
            if i + 1 < len(args) and not args[i + 1].startswith("--"):
                flags[key] = args[i + 1]
                i += 1
            else:
                flags[key] = True
        i += 1
    return flags


def number_flag(value, fallback, name):
    if value is None or value is True or value == "":
        return fallback
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a non-negative integer.")
    if n < 0:
        raise ValueError(f"{name} must be a non-negative integer.")
    return n


def find_git_root(start_dir):
    try:
        out = subprocess.check_output(
            ["git", "-C", start_dir, "rev-parse", "--is-inside-work-tree", "--show-toplevel"],
            stderr=subprocess.DEVNULL,
            encoding="utf-8",
        )
        lines = [l.strip() for l in out.splitlines() if l.strip()]
        return lines[1] if lines and lines[0] == "true" and len(lines) > 1 else None
    except Exception:
        return None


def find_schelling_root(start_dir):
    d = os.path.realpath(start_dir)
    while True:
        if os.path.exists(os.path.join(d, PROJECT_ID_RELATIVE)):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def find_project_root(start_dir):
    return find_git_root(start_dir) or find_schelling_root(start_dir)


def get_project_id(start_dir):
    root = find_project_root(start_dir)
    if not root:
        return None
    try:
        with open(os.path.join(root, PROJECT_ID_RELATIVE), "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped:
                    return stripped
    except OSError:
        pass
    return None


def require_project_id():
    pid = get_project_id(os.getcwd())
    if not pid:
        raise ValueError("no project_id found; run `directionally --setup` first")
    return pid


def parse_github_remote(url):
    import re
    ssh = re.match(r"^git@github\.com:([^/]+)/([^/]+?)(?:\.git)?$", url, re.IGNORECASE)
    if ssh:
        return {"owner": ssh.group(1), "name": ssh.group(2)}
    https_ = re.match(
        r"^(?:https?://|ssh://git@|git://)?(?:[^@]+@)?github\.com[/:]([^/]+)/([^/]+?)(?:\.git)?/?$",
        url,
        re.IGNORECASE,
    )
    if https_:
        return {"owner": https_.group(1), "name": https_.group(2)}
    return None


def pick_github_repo(remotes_output):
    import re
    origin = None
    first = None
    for line in remotes_output.splitlines():
        m = re.match(r"^(\S+)\s+(\S+)\s+\((?:fetch|push)\)\s*$", line)
        if not m:
            continue
        name, url = m.group(1), m.group(2)
        repo = parse_github_remote(url)
        if not repo:
            continue
        entry = {**repo, "remote_name": name, "remote_url": url}
        if name == "origin" and origin is None:
            origin = entry
        if first is None:
            first = entry
    return origin or first


def write_if_changed(file_path, content):
    existed = os.path.exists(file_path)
    if existed:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                if f.read() == content:
                    return {"path": file_path, "action": "unchanged"}
        except OSError:
            pass
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
    return {"path": file_path, "action": "updated" if existed else "created"}


def download_skill(url):
    req = urllib.request.Request(url, headers={"User-Agent": user_agent()})
    with urllib.request.urlopen(req, timeout=15) as resp:
        if resp.status != 200:
            raise ValueError(f"Could not download SKILL.md from {url}: HTTP {resp.status}")
        return resp.read().decode("utf-8")


def cmd_setup(flags):
    cwd = flags.get("cwd")
    if not cwd or cwd is True:
        cwd = os.getcwd()
    forced_id = flags.get("force")
    if forced_id is True:
        forced_id = None

    git_root = find_git_root(cwd)
    target_root = git_root or os.path.realpath(cwd)

    if forced_id:
        project_id = forced_id
        project_source = "--force"
    elif git_root:
        try:
            remotes = subprocess.check_output(
                ["git", "-C", git_root, "remote", "-v"],
                stderr=subprocess.DEVNULL,
                encoding="utf-8",
            )
        except Exception:
            remotes = ""
        repo = pick_github_repo(remotes)
        if not repo:
            raise ValueError("Could not find a github.com remote. Use --force <owner/repo>.")
        project_id = f"{repo['owner']}/{repo['name']}"
        project_source = f"{repo['remote_name']} {repo['remote_url']}"
    else:
        raise ValueError("Could not find a git root. Use --force <owner/repo>.")

    skill_url = os.environ.get("DIRECTIONALLY_SKILL_URL", DEFAULT_SKILL_URL)
    skill_body = download_skill(skill_url)

    files = [
        {**write_if_changed(os.path.join(target_root, SKILL_RELATIVE), skill_body), "rel": SKILL_RELATIVE},
        {**write_if_changed(os.path.join(target_root, SKILL_CLAUDE_RELATIVE), skill_body), "rel": SKILL_CLAUDE_RELATIVE},
        {**write_if_changed(os.path.join(target_root, PROJECT_ID_RELATIVE), project_id + "\n"), "rel": PROJECT_ID_RELATIVE},
    ]

    lines = [f"Project: {project_id} (from {project_source})", f"Root: {target_root}", ""]
    for f in files:
        lines.append(f"  {f['action']:<9} {f['rel']}")
    sys.stdout.write("\n".join(lines) + "\n")


def open_first_session(project_id, api_base, initial_message):
    parsed = urllib.parse.urlparse(api_base)
    is_https = parsed.scheme == "https"
    host = parsed.hostname
    port = parsed.port or (443 if is_https else 80)
    path = f"{parsed.path}/sessions/{urllib.parse.quote(project_id, safe='')}"

    conn_cls = http.client.HTTPSConnection if is_https else http.client.HTTPConnection
    conn = conn_cls(host, port, timeout=120)

    body_parts = []
    if initial_message:
        body_parts.append(json.dumps(initial_message) + "\n")
    body = "".join(body_parts).encode("utf-8")

    conn.request(
        "POST",
        path,
        body=body or None,
        headers={
            "Content-Type": "application/x-ndjson",
            "Accept": "application/x-ndjson",
            "User-Agent": user_agent(),
            "Content-Length": str(len(body)),
        },
    )
    resp = conn.getresponse()

    if resp.status < 200 or resp.status >= 300:
        err_body = resp.read(500).decode("utf-8", errors="replace")
        write_ndjson({
            "kind": "bridge_error",
            "error": f"HTTP {resp.status} {resp.reason}{': ' + err_body if err_body else ''}",
            "received_at": now_iso(),
        })
        sys.exit(1)

    sequence = 0

    while True:
        raw = resp.readline()
        if not raw:
            break
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("kind") == "event_received" and isinstance(obj.get("sequence"), int):
            sequence = obj["sequence"]
            continue
        if obj.get("kind") == "session_started":
            write_ndjson({
                "kind": "bridge_started",
                "api_base": api_base,
                "project_id": project_id,
                "session_id": obj["session_id"],
                "sequence": sequence,
                "received_at": now_iso(),
            })
            conn.close()
            return
        write_ndjson(obj)

    write_ndjson({
        "kind": "bridge_error",
        "error": "session stream ended before session_started",
        "received_at": now_iso(),
    })
    sys.exit(1)


def send_ops(session_id, api_base, ops):
    parsed = urllib.parse.urlparse(api_base)
    is_https = parsed.scheme == "https"
    host = parsed.hostname
    port = parsed.port or (443 if is_https else 80)
    path = f"{parsed.path}/session/resume/{urllib.parse.quote(session_id, safe='')}"
    body = ("\n".join(json.dumps(op) for op in ops) + "\n").encode("utf-8")

    conn_cls = http.client.HTTPSConnection if is_https else http.client.HTTPConnection
    conn = conn_cls(host, port, timeout=30)
    try:
        conn.request(
            "POST",
            path,
            body=body,
            headers={
                "Content-Type": "application/x-ndjson",
                "User-Agent": user_agent(),
                "Content-Length": str(len(body)),
            },
        )
        resp = conn.getresponse()
        if resp.status < 200 or resp.status >= 300:
            err_body = resp.read(200).decode("utf-8", errors="replace")
            sys.stderr.write(f"directionally: ops not sent: HTTP {resp.status}{': ' + err_body if err_body else ''}\n")
        else:
            resp.readline()  # read first line then close; stream stays open server-side
    except Exception as e:
        sys.stderr.write(f"directionally: ops not sent: {e}\n")
    finally:
        conn.close()


def poll_session(project_id, api_base, flags):
    session_id = flags.get("session", "")
    if session_id is True or not session_id:
        raise ValueError("--session requires a session id.")
    session_id = str(session_id).strip()

    after = number_flag(flags.get("after"), 0, "--after")
    wait = number_flag(flags.get("wait"), 0, "--wait")
    limit = number_flag(flags.get("limit"), 100, "--limit")

    ops = []
    for arg in flags.get("_", []):
        try:
            ops.append(json.loads(arg))
        except json.JSONDecodeError:
            pass
    if ops:
        send_ops(session_id, api_base, ops)

    params = urllib.parse.urlencode({"after": after, "wait": wait, "limit": limit})
    url = (
        f"{api_base}/sessions/{urllib.parse.quote(project_id, safe='')}"
        f"/{urllib.parse.quote(session_id, safe='')}/events.ndjson?{params}"
    )
    req = urllib.request.Request(
        url,
        headers={"Accept": "application/x-ndjson", "User-Agent": user_agent()},
    )
    try:
        with urllib.request.urlopen(req, timeout=wait + 10) as resp:
            text = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} {e.reason}{chr(10) + err_body if err_body else ''}")

    if text:
        if not text.endswith("\n"):
            text += "\n"
        sys.stdout.write(text)
        sys.stdout.flush()
    count = len([l for l in text.strip().splitlines() if l.strip()]) if text.strip() else 0
    write_ndjson({"kind": "polled", "count": count, "after": after, "received_at": now_iso()})


def usage(code=0):
    msg = "\n".join([
        "Usage:",
        "  directionally.py --setup [--cwd <path>] [--force <owner/repo>]",
        "  directionally.py --first --subsession-id <id> <text>",
        "  directionally.py --session <session_id> [--after <seq>] [--wait <secs>] [--limit <n>]",
        "",
        "Env:",
        f"  DIRECTIONALLY_API_BASE   Override API base URL (default: {DEFAULT_API_BASE})",
        "  DIRECTIONALLY_SKILL_URL  Override SKILL.md source URL used by --setup",
    ])
    (sys.stdout if code == 0 else sys.stderr).write(msg + "\n")
    sys.exit(code)


def main():
    ping_dir = os.path.join(os.path.expanduser("~"), ".directionally")
    os.makedirs(ping_dir, exist_ok=True)
    with open(os.path.join(ping_dir, "ping"), "w") as _f:
        _f.write(str(random.randint(0, 2**31 - 1)))

    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help", "help"):
        usage(0)

    try:
        flags = parse_args(args)

        if flags.get("setup"):
            cmd_setup(flags)
            return

        api_base = get_api_base()
        project_id = require_project_id()

        if flags.get("first"):
            subsession_id = flags.get("subsession_id")
            if subsession_id is True:
                subsession_id = None
            text = " ".join(flags["_"]) if flags.get("_") else None
            initial_message = (
                {"op": "elaborating", "subsession_id": subsession_id, "text": text}
                if subsession_id and text
                else None
            )
            open_first_session(project_id, api_base, initial_message)
            return

        if flags.get("session"):
            poll_session(project_id, api_base, flags)
            return

        usage(1)

    except ValueError as e:
        fail(str(e))
    except RuntimeError as e:
        fail(str(e))
    except Exception as e:
        fail(str(e))


if __name__ == "__main__":
    main()
