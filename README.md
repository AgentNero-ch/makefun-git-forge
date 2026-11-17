# AgentNero-ch/makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/AgentNero-ch/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/AgentNero-ch/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

## github-core — a one-process GitHub-compatible forge

A standalone Git forge that speaks the four surfaces AI agents already use, from one Node process and
one in-memory store: git smart HTTP (protocol v2), the REST v3 routes, GraphQL v4, and the Model
Context Protocol endpoint.

It is the entry for the [github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty.
It has no dependencies: `node:http`, `node:zlib`, `node:crypto` and its own modules only.

## Run it

```sh
# In a trial the harness starts you: main.ts binds an ephemeral port, registers with the env
# (MAKEFUN_ENV_URL) and polls /done. Nothing to install.
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node --experimental-strip-types main.ts

# Day to day: bind a port yourself (app-serve.ts is the development entry).
MAKEFUN_SHOP_TOKEN=tok node --experimental-strip-types app-serve.ts 8080
```

Every API and git call must carry `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; `/healthz` takes none.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | `{"ok":true}` — the boot probe |
| `GET /api/v3/` | the API root, with `X-OAuth-Scopes` |
| `/api/v3/...` | repositories, branches, commits, contents, git refs, issues, comments, labels, pull requests, merges |
| `POST /api/graphql` | viewer, repository fields, issues, pull requests, node, introspection, and the create/close/merge/comment mutations; operation batching |
| `POST /mcp` | MCP over streamable HTTP: initialize, tools/list, tools/call (9 tools) |
| `/{owner}/{repo}.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2: ls-refs, fetch with shallow/deepen), `git-receive-pack` (report-status, side-band-64k, delete-refs) |
| anything else | `404 {"message":"Not Found"}` |

## Layout

```
main.ts             the entry <-> env lifecycle (bind, register, poll /done, exit) — do not edit
app.ts              the HTTP router: auth, git paths, REST, GraphQL, MCP
app-serve.ts        the development listener (binds the port given on the command line)
src/git.ts          objects, trees, commits, packs (read/write, delta apply), pkt-line framing
src/store.ts        users, repositories, refs, issues, comments, labels, pull requests, merges
src/githttp.ts      info/refs, protocol-v2 upload-pack, v0 receive-pack
src/rest.ts         the REST v3 routes
src/graphql.ts      the GraphQL parser, schema description and executor
src/mcp.ts          JSON-RPC 2.0, the handshake and the tools
src/http.ts         JSON answers, request ids, body parsing, error bodies
```

## Design notes

- **One store, four surfaces.** Everything reads and writes the same `Store`: a push updates the same
  refs a `GET /branches` lists, and an MCP `create_issue` is the issue REST reads back.
- **Git is implemented, not shelled out.** No `git` binary exists in a trial: packs are parsed and
  written here, deltas applied here, and the refs, trees and commits are the store's own objects.
- **The forge is stateless across restarts.** Data lives in memory for the life of the process; a
  fresh process starts with the viewer's account and an empty forge.
- **Caches are derived, never authoritative.** Serialized issue answers, advertisement bodies and
  built packs are cached against a repository `version` counter that every ref or object change bumps,
  so a cache can never serve a stale tip.

## Local grading

The kit ships the suite the trial runs. From inside the kit directory:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8080 --token "$TOKEN" [--perf] [--json]
```

The last measured run: 120/120 conformance checks (git 30, repos 15, issues 15, pulls 20, GraphQL 20,
MCP 15, protocol 5), 15/15 on the MCP column, and 163–174/200 on the four benchmark workloads.

## Licence

MIT (see `LICENSE`).
