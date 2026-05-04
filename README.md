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

## Environment

- `SCHELLING_API_BASE`: override API base URL (default `https://api.schelling.sh`)

## User-Agent

The CLI automatically sends `User-Agent: schelling/<version>`.
