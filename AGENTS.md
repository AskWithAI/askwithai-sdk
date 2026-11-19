# Agent instructions for `@askwithai/sdk`

This is the public, MIT-licensed client for [AskWithAI](https://askwith.ai): the typed
`AskWithAI` client (`src/client.ts`), typed decisions (`src/decision.ts`), a faux in-process
server for an app's own tests (`src/testing.ts`), and the `askwithai` command
(`src/cli.ts`). It is consumed by `code/ask-with-ai` itself and by other apps on the platform
(`code/pullup`, `code/theory`) as a real npm dependency, never a workspace link — see
`code/AGENTS.md`'s cross-repo rule before changing anything here.

## Keeping the CLI usable as the API grows

The `askwithai` command has two halves, and they're kept in sync differently:

- **`askwithai call <method> <path>` and `askwithai endpoints`** read the *live*
  `/api/v1/openapi.json` from `code/ask-with-ai` at run time. That spec is contract-tested there
  against the real route handlers (`test/openapi-contract.test.ts`), so these two commands are
  automatically correct for every endpoint, including ones added after this package's last
  release — no code change here is ever needed for them to work.
- **Every other command** (`decide`, `runtimes`, `reviews`, `learned`, `templates`, `privacy`,
  etc.) is a curated, ergonomic shortcut: a named command with real flags, backed by a thin
  method on `AskWithAI` in `client.ts`. These need a code change and a release when the API
  changes.

When you add or change an endpoint in `code/ask-with-ai`'s `server/openapi.ts`: nothing here
breaks, and `askwithai call`/`askwithai endpoints` pick it up automatically. Only add or update a
curated command in this repository when the endpoint is a primary workflow where named flags and
formatted output are worth it over `call` — and update the matching row in
`code/ask-with-ai`'s `docs/integrating/cli.md` in the same change.

## Code

- `cli.ts` commands must be thin wrappers over a `client.ts` method (parse flags, call the
  method, format the result) — never a bespoke `fetch` call. `client.request()` is the one
  place that builds a request; reuse it.
- `call` and `endpoints` must stay fully generic: no per-path special-casing, no knowledge of
  any specific endpoint's shape. That genericness is what makes them need no maintenance.
- Every curated command needs a unit test in `cli.test.ts` against a mocked `fetch` (see the
  existing tests for the pattern): assert the request's method, path and body, and the printed
  output. `push`/`check`/`mode`/`replay` are instead exercised end to end against the real
  server in `code/ask-with-ai`'s `server/sdk.test.ts`; a new curated command doesn't need that
  as well unless it's one of the primary flows worth that extra coverage.
- A new client method follows the existing style in `client.ts`: a short doc comment, a thin
  wrapper over `this.request()`, and a narrow return type.

## Checks before finishing

`pnpm typecheck && pnpm test && pnpm build`.

## Releasing

Publishing is public and irreversible: a push of a `v*` tag runs the `publish` job in
`.github/workflows/ci.yml` and puts a new version on the public npm registry. Bump
`package.json`'s version, then tag and push only when asked to release, not as a routine part of
a change.
