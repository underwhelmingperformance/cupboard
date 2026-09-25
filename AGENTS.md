# `cupboard`

A Cloudflare Workers substituter for Nix.

See [PLAN.md](./PLAN.md) for the feature plan and current progress,
[docs/contributing/README.md](./docs/contributing/README.md) for setting up and
running the checks, and
[docs/contributing/architecture.md](./docs/contributing/architecture.md) for how
the system fits together.

## Layout

This is a pnpm workspace.

- `packages/cli` - the `cupboard` CLI used to push store paths, manage tenants
  and keys, and print Nix configuration.
- `packages/server` - the Worker entrypoint and the `CupboardServer` Durable
  Object that backs the binary cache. There is one DO per tenant; it holds the
  tenant's persisted state via DO SQLite, the control plane uses D1, and R2
  holds the NAR and attestation bytes.
- `packages/nix-store` - the Nix domain layer: NAR/narinfo parsing, store paths,
  hashes, and the branded scalars. Pure and isomorphic; safe in the Worker.
- `packages/nix` - the live Nix client (`class Nix`): queries the running store
  on the system, reading through the daemon or the local store. Node-only.
- `packages/protocol` - the contract-first oRPC declarations for the JSON admin
  API plus the domain schemas they share.
- `packages/shared` - attestation verification (`in-toto`, `sigstore`, `slsa`),
  the shared Octokit client, and typed errors.
- `packages/logger` - logging configuration on LogTape.
- `packages/reporter` and `packages/cli-ui` - terminal/JSON output.
- `actions/` - the composite GitHub Actions (`setup`, `build-paths`, `push`,
  `attest`, `attest-attach`, and the internal steps of the reusable workflows).
- `tests/` - the end-to-end, conformance and performance suites, their shared
  support code and fixtures.
- `scripts/` - repository tooling: the binary build, releases, generated
  references, and dependency and migration checks.
- `docs/` - user, operator and contributor documentation, indexed by
  [docs/README.md](./docs/README.md).

## Conventions

- British English in code and docs.
- Always install with `pnpm add` and `pnpm add -D`, scoped to a package with
  `--filter @cupboard/<name>`.
- Use guard clauses and early returns; keep the happy path left-aligned.
- Be type-first: prefer explicit types and small domain models over ad-hoc
  untyped objects.
- Run `pnpm check` before committing. It runs every `check:*` script:
  `syncpack`, `prettier`, `eslint`, `knip`, `tsc`, the unit tests, and the
  end-to-end and conformance suites, which need Nix and Docker. Treat every
  finding as actionable.
- `pnpm fix` applies the auto-fixable parts (`syncpack format`,
  `prettier --write`, `eslint --fix`).
- Install pre-commit hooks with `pre-commit install`. The hooks run upstream
  file hygiene checks plus the workspace dependency, format, lint, Knip, and
  type gates before commits.
- Commit messages follow Conventional Commits, with bodies wrapped at 72
  columns; CI checks both.
- Never suppress or weaken a linter rule to avoid an applicable finding. A
  narrowly scoped suppression is permitted for a demonstrable tool false
  positive when the configuration cites authoritative evidence and an upstream
  issue. Remove it once the pinned tool supports the construct.

## Documentation

- User and operator docs describe the current release. Steps an operator must
  take for one particular upgrade go in
  [docs/operator/upgrade-notes.md](./docs/operator/upgrade-notes.md), not in the
  guides.
- `docs/reference/cli.md` and `docs/reference/actions.md` are generated from the
  command definitions and the action and workflow YAML. After changing either,
  run `pnpm update:cli-reference` or `pnpm update:actions-reference`; tests fail
  while they are stale.
- Examples use `https://cupboard.example.workers.dev`, the instance name
  `cupboard`, the tenant `acme`, the repository `acme/app`, the release `vX.Y.Z`
  and keys named `cupboard-acme-1:...`.
- Use one term per concept: operator; tenant administrator (owner only for the
  identity fixed at creation); tenant read credential and cache read credential;
  deployment URL, tenant URL and cache URL; trust rule and grant; publish for
  the outcome and push for the command.
- Every factual claim should be checkable against the code. When behaviour
  changes, update the page that owns the topic rather than adding a note
  elsewhere.
- Reference cupboard's actions and workflows as
  `underwhelmingperformance/cupboard/...`, never as a copy in the caller's
  repository.

## Coding Standards

- Do not put program logic in `index.ts` files; keep them to module entrypoints
  and re-exports.
- All HTTP routing in `packages/server` is Hono: the worker app in
  `routing/handler.ts`, the control plane in `control/control-app.ts`, and the
  tenant Durable Object's app in `do/server.ts`. Never hand-roll a dispatcher
  over pathnames. Authentication, maintenance eligibility and cache scoping are
  middleware; services take parsed values and return typed protocol objects,
  with the route layer doing the parsing and rendering. Only the following
  endpoints handle raw Request/Response: OAuth, the Nix binary-cache protocol,
  the commit WebSocket, and streamed object serves.
- Hono answers HEAD by re-dispatching the request to the GET handler with the
  body stripped, so register reads with `.get()`; an explicit HEAD registration
  never matches.
- The JSON admin APIs are contract-first: every procedure's method, path, input,
  output, errors and scope metadata is declared exactly once, in
  `@cupboard/protocol/contract`. The server implements the contract with oRPC
  (`packages/server/src/orpc/`) and the CLI derives its clients from it
  (`tenantRpc`/`controlRpc` in `packages/cli/src/client/orpc.ts`), with
  responses validated at runtime on both sides. A new admin endpoint starts as a
  contract procedure; never add a hand-written route and client pair for JSON.
  Only the raw Request/Response endpoints listed above stay outside the
  contract, on the slim hand-written `CupboardClient`.
