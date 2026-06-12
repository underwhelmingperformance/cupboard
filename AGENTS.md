# `cupboard`

A Cloudflare Workers substituter for Nix.

See [PLAN.md](./PLAN.md) for the feature plan and current progress.

## Layout

This is a pnpm workspace with two packages:

- `packages/cli` - the `cupboard` CLI used to push store paths and print Nix
  configuration.
- `packages/server` - the Worker entrypoint and `CupboardServer` Durable Object
  that backs the binary cache. There is one DO per deployment; it holds all
  persisted state via DO SQLite, and the R2 bucket holds NAR bytes.

Shared utilities (NAR/narinfo parsing, hashing) will live in a third package
when both sides need them; for now keep that code in whichever package consumes
it.

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
