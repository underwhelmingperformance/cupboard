# `cupboard`

A Cloudflare Workers substituter for Nix.

See [PLAN.md](./PLAN.md) for the feature plan and current progress.

## Layout

This is a pnpm workspace.

- `packages/cli` - the `cupboard` CLI used to push store paths, manage tenants
  and keys, and print Nix configuration.
- `packages/server` - the Worker entrypoint and the `CupboardServer` Durable
  Object that backs the binary cache. There is one DO per tenant; it holds the
  tenant's persisted state via DO SQLite, the control plane uses D1, and R2
  holds the NAR and attestation bytes.
- `packages/nix-store` - the Nix domain layer: NAR/narinfo parsing, store paths,
  hashes, and the branded scalars.
- `packages/protocol` - the contract-first oRPC declarations for the JSON admin
  API plus the domain schemas they share.
- `packages/shared` - attestation verification (`in-toto`, `sigstore`, `slsa`),
  the shared Octokit client, and typed errors.
- `packages/reporter` and `packages/cli-ui` - terminal/JSON output.
- `actions/` - the composite GitHub Action (`setup`, `push`, `attest`).

## Conventions

- British English in code and docs.
- Always install with `pnpm add` and `pnpm add -D`, scoped to a package with
  `--filter @cupboard/<name>`.
- Use guard clauses and early returns; keep the happy path left-aligned.
- Be type-first: prefer explicit types and small domain models over ad-hoc
  untyped objects.
- Run `pnpm check` before committing. It runs `syncpack`, `prettier`, `eslint`,
  `knip`, `tsc`, and `vitest` across the workspace. Treat every finding as
  actionable.
- `pnpm fix` applies the auto-fixable parts (`syncpack format`,
  `prettier --write`, `eslint --fix`).
- Install pre-commit hooks with `pre-commit install`. The hooks run upstream
  file hygiene checks plus the workspace dependency, format, lint, Knip, and
  type gates before commits.

## Coding Standards

- Do not put program logic in `index.ts` files; keep them to module entrypoints
  and re-exports.
- All HTTP routing in `packages/server` is Hono: the worker app in
  `routing/handler.ts`, the control plane in `control/control-app.ts`, and the
  tenant Durable Object's app in `do/server.ts`. Never hand-roll a dispatcher
  over pathnames. Authentication, maintenance eligibility and cache scoping are
  middleware; services take parsed values and return typed protocol objects,
  with the route layer doing the parsing and rendering. Only wire-format
  endpoints (OAuth, the Nix binary-cache protocol, the commit WebSocket,
  streamed object serves) handle raw Request/Response.
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
  Only wire-format endpoints listed above stay outside the contract, on the slim
  hand-written `CupboardClient`.
