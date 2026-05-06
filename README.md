# Story CLI

> Git tells you what changed. Story tells you why.

Story is an independent TypeScript rewrite of the MIT-licensed Entire CLI. It
captures AI coding-agent sessions through git and agent hooks, stores them as
checkpoints, and lets you inspect or rewind the history behind a commit.

This project is built with respect for Entireio and the original Entire CLI. It
uses the Go implementation in `entireio-cli/` as a behavioral reference, but it
is a personal open-source project and is not an official Entireio project unless
that is stated elsewhere.

## Features

- Record agent sessions as git-backed checkpoints.
- Link checkpoints to commits with `Story-Checkpoint:` trailers.
- Support rewind, explain, resume, attach, clean, doctor, trace, and shell
  completion workflows.
- Read transcripts from Claude Code, Cursor, Codex, OpenCode, Vogon, and
  external `story-agent-*` plugins.
- Store metadata under `.story/` and checkpoint refs under `story/...`.
- Redact common secrets and high-entropy values before committed checkpoint
  metadata is written.

## Installation

```bash
npm install -g @storyio/cli
story --help
```

When working from source:

```bash
bun install
bun run build
node dist/cli.js --help
```

The package publishes a `story` binary from `dist/cli.js`, so a build is
required before using a linked checkout as a global CLI.

## Quick Start

Enable Story in a git repository:

```bash
story enable
```

Check current state:

```bash
story status
story sessions list
```

Inspect or recover work:

```bash
story explain HEAD
story rewind --list
story resume <branch>
```

Run `story help <command>` for command-specific flags, or `story help --tree`
for the full command tree.

## Development

This repository uses Bun for development scripts and builds a Node-compatible
ESM CLI with `tsup`.

```bash
bun install
bun run dev             # tsup --watch
bun run build           # dist/cli.js and the Vogon E2E binary
bun run test            # unit tests
bun run test:integration
bun run type-check
```

E2E tests use real git hooks and a deterministic Vogon test agent:

```bash
bun run test:e2e
bun run test:e2e:keep   # keep temporary repos and artifacts for debugging
```

Do not run E2E tests casually in unrelated repositories. They are designed to
run inside isolated temporary git repos.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `src/` | TypeScript CLI implementation |
| `tests/` | Unit, integration, and E2E tests |
| `docs/` | Design notes, rewrite plan, and reference documentation |
| `entireio-cli/` | Go reference implementation used for behavior parity |
| `AGENTS.md` | Development rules for AI agents and contributors |

## Documentation

- `docs/ts-rewrite/main.md` explains the TypeScript rewrite plan and module map.
- `docs/ts-rewrite/impl/README.md` tracks phase-by-phase implementation status.
- `docs/ts-rewrite/wiki/wiki.md` is the business-logic wiki for checkpoints,
  hooks, sessions, attribution, and rewind.
- `docs/references/go-source-map.md` maps Go source areas to TypeScript modules.
- `docs/security-and-privacy.md` explains what Story stores and how redaction
  works.

## Security and Privacy

Story stores prompts, transcripts, metadata, and checkpoint summaries in git
objects and checkpoint refs. Treat those refs as repository data: if you push
them to a public remote, collaborators and readers of that remote may be able
to inspect the stored session history.

Redaction is a safety net, not a guarantee. Review sensitive sessions before
pushing checkpoint refs to a remote.

## License

Story is released under the MIT License. See `LICENSE`.

The reference Entire CLI under `entireio-cli/` is also MIT-licensed by Entire
Inc.; see `entireio-cli/LICENSE`.
