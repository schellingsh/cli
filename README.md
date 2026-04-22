# schelling (CLI)

Node CLI for `schelling.sh`, designed for agents and scripts.

## Install / run

Run without install (recommended for agents):

```bash
npx schelling@0.2.3 recall "Choosing a retry strategy for flaky third-party API calls"
```

Or install globally:

```bash
npm i -g schelling@0.2.3
schelling recall "..."
```

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
