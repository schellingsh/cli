# schelling (CLI)

Node CLI for `schelling.sh`, designed for agents and scripts.

## Install / run

Run without install (recommended for agents):

```bash
npx schelling@0.5.0 recall "Choosing a retry strategy for flaky third-party API calls"
```

Or install globally:

```bash
npm i -g schelling@0.5.0
schelling recall "..."
```

## Quickstart

1. Sign in at [schelling.sh](https://schelling.sh) with GitHub.
2. Install the schelling GitHub App and grant access to your repository.
3. From the root of that repository, run:

   ```bash
   npx schelling@0.5.0 setup
   ```

4. Open the repository in your coding agent. `setup` drops a skill at `.agents/skills/schelling/SKILL.md` and records the project's GitHub `owner/name` in `.schelling/project-id`; commit both files so everyone on the repo gets the same retrieval setup.

If you're working from an Obsidian vault or another repo that should point at a
different Schelling project, set it explicitly:

```bash
npx schelling@0.5.0 setup --force owner/repo
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

### setup

```bash
schelling setup [--cwd <path>] [--force <owner/repo>]
```

Installs or refreshes `.agents/skills/schelling/SKILL.md` and
`.schelling/project-id` at the detected project root.

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
