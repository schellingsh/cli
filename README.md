# Directionally CLI

Agent-oriented CLI for Directionally sessions.

## Quickstart

Install or refresh project-local skill files and `.schelling/project-id`:

```bash
npx directionally@0.2.0 --setup
```

Create the first session for an agent turn:

```bash
npx directionally@0.2.0 --first \
  --subsession-id run_001 \
  --elaboration "Initial read of the task."
```

Poll later with the returned session id:

```bash
npx directionally@0.2.0 --session sess_abc123 --after 42 --wait 30
```

The default interface prints NDJSON to stdout. Agents should store the
`session_id` from `bridge_started` and advance their cursor from event
`sequence` values.

## Default Interface

### `--setup`

```bash
directionally --setup [--cwd <path>] [--force <owner/repo>]
```

Installs or refreshes:

- `.agents/skills/directionally/SKILL.md`
- `.claude/skills/directionally/SKILL.md`
- `.schelling/project-id`

By default, setup infers `owner/repo` from the GitHub remote. Use
`--force owner/repo` to set it explicitly.

### `--first`

```bash
directionally --first [--subsession-id <id>] [--elaboration <text>]
```

Opens `POST /sessions/{project_id}` and exits after the backend closes the
request/response. When the
backend assigns a session, the CLI emits:

```json
{"kind":"bridge_started","session_id":"sess_...","sequence":0}
```

If `--subsession-id` and `--elaboration` are supplied, the CLI sends the initial
elaboration immediately after opening the session.

The process also accepts immediate NDJSON on stdin and forwards each JSON line
before closing the request. Use `--session` for later reads.

### `--session`

```bash
directionally --session <session_id> [--after <seq>] [--wait <secs>] [--limit <n>]
```

Polls the session event log through:

```text
GET /sessions/{project_id}/{session_id}/events.ndjson
```

Options:

- `--after` returns events with `sequence > after`. Default: `0`.
- `--wait` long-polls for new events. Default: `30`.
- `--limit` caps returned events. Default: `100`.

## Environment

- `DIRECTIONALLY_API_BASE`: override API base URL. Default:
  `https://api.directionally.ai`.
- `DIRECTIONALLY_SKILL_URL`: override the `SKILL.md` source used by setup.

## User Agent

The CLI sends `User-Agent: directionally/<version>`.
