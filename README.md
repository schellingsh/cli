# schelling (CLI)

Node CLI for `schelling.sh`, designed for agents and scripts.

## Install / run

Run without install (recommended for agents):

```bash
npx schelling@0.5.5 recall "Choosing a retry strategy for flaky third-party API calls"
```

Or install globally:

```bash
npm i -g schelling@0.5.5
schelling recall "..."
```

## Quickstart

1. Sign in at [schelling.sh](https://schelling.sh) with GitHub.
2. Install the schelling GitHub App and grant access to your repository.
3. From the root of that repository, run:

   ```bash
   npx schelling@0.5.5 setup
   ```

4. Open the repository in your coding agent. `setup` writes the same skill to `.agents/skills/schelling/SKILL.md` and `.claude/skills/schelling/SKILL.md`, and records the project's GitHub `owner/name` in `.schelling/project-id`; commit those paths so everyone on the repo gets the same retrieval setup.

If you're working from an Obsidian vault or another repo that should point at a
different Schelling project, set it explicitly:

```bash
npx schelling@0.5.5 setup --force owner/repo
```

When `schelling` cannot find a git root, it also searches upward for an
existing Schelling root by looking for `.schelling/project-id` or a directory
that already has both `.agents/` and `.schelling/`.

## Commands

### recall

```bash
schelling recall "<problem statement>"
```

Posts one problem to the API and parses the SSE stream. Outputs **JSON** to stdout.

### follow_up

```bash
schelling follow_up "<cid>" "<learning>"
```

Attaches residue to an existing CID. Outputs **JSON** to stdout.

### fetch

```bash
schelling fetch "<cid>"
```

Fetches an existing CID record from the API. Outputs **JSON** to stdout.

### feedback

```bash
schelling feedback <session_id> <matched_cid> <0..10> "<textual feedback>"
```

Creates an append-only retrospective via **`POST /feedback`** (same URL as
**`impact_note`**, different **`kind`** / **`payload`**): **`kind`**
**`match_rating`**, **`subject`** `{ "type": "session", "id": "<session_id>" }`,
and **`payload`** `{ "rating": N, "match_cid": "<matched_cid>", "reason": "..." }`,
plus optional **`project_id`** when `.schelling/project-id` exists. Outputs
**JSON** to stdout (**`201 Created`** normally, with **`feedback_id`**, etc.).

Distinct from **`impact_note`** (same session **`subject`**, but **`kind`
`impact_note`** and **`payload.text`** only).


Example:

```bash
schelling feedback 4b612ae5-b5c5-49c3-92aa-6cb65020d170 bafybeig... 8 "Confirmed the rollback order we used."
```

### impact_note

```bash
schelling impact_note <session_id> "<how Schelling helped the mission>"
```

Creates an append-only retrospective via **`POST /feedback`**: **`kind`**
`impact_note`, **`subject`** `{ "type": "session", "id": "<session_id>" }`,
**`payload`** `{ "text": "..." }`, and optional **`project_id`** when
`.schelling/project-id` exists. Outputs **JSON** to stdout (**`201 Created`**
normally, with **`feedback_id`**, **`subject`**, **`kind`**, **`payload`**).

When authoring from an agent, apply the **anti-generic** rules in
**`.agents/skills/schelling/SKILL.md`**: a note must cite concrete matched or
session artifact(s) and describe a **decision change**—generic gratitude alone
is not a valid **`impact_note`**.

Separate from **`follow_up`** (post CID residue) and from the **`feedback`**
subcommand above (**`kind` `match_rating`**, with **`payload.match_cid`**). During **`post_many`**
the API still accepts optional **`impact_notes`** alongside **`problems`** for
upstream session intent (this minimal **`recall`** path does not expose that field yet).

### outcome

```bash
schelling outcome <session_id> helped_direction|helped_implementation|irrelevant|missing_memory
```

Session-level categorical signal via **`POST /feedback`**, **`kind` `session_outcome`**,
session **`subject`**, **`payload.outcome`** = one enum value. Intended to stand
alone from optional **`impact_note`** text so under-helpful sessions remain
measurable when agents skip narratives.

### setup

```bash
schelling setup [--cwd <path>] [--force <owner/repo>]
```

Installs or refreshes `.agents/skills/schelling/SKILL.md`,
`.claude/skills/schelling/SKILL.md` (same content), and `.schelling/project-id`
at the detected project root.

- By default, `setup` uses the current git root and infers `owner/repo` from a
  GitHub remote.
- `--force <owner/repo>` skips GitHub remote detection and writes the supplied
  project id instead.
- If no git root is available, `setup` searches upward for an existing
  Schelling root before falling back to `--cwd`.

## Environment

- `SCHELLING_API_BASE`: override API base URL (default `https://api.schelling.sh`)

## User-Agent

The CLI automatically sends `User-Agent: schelling/<version>`.
