# cupboard

cupboard is a multi-tenant [Nix] binary cache that runs on [Cloudflare Workers].
It serves store paths over the standard Nix binary-cache protocol, backed by R2
for NAR bytes and a Durable Object per tenant for the metadata, signing keys,
and retention bookkeeping. One deployment hosts many independent tenants, each
with its own caches, keys, and access rules.

The `cupboard` CLI both stands a deployment up and operates it day to day: it
pushes store paths, manages tenants and their keys, configures retention, and
prints the `nix.conf` a client needs to substitute from a cache.

## Two roles

The commands divide along the line between running the service and using a
tenant within it.

An **operator** owns the deployment. They provision it, create and offboard
tenants, and manage the control-plane signing keys. These commands address the
deployment by its bare host and are marked "operator only" in the help:

- `cupboard init` (alias `cupboard deploy`) provisions the Workers, R2 bucket,
  D1 database, and queues on a Cloudflare account.
- `cupboard tenant` creates, suspends, resumes, and removes tenants, and rotates
  their read credentials.
- `cupboard control-key` rotates the keys that sign control-plane tokens.

A **tenant admin** owns one tenant within a deployment. They push paths, manage
the tenant's caches and retention, and rotate the keys that sign its narinfos.
These commands address the tenant, so their URL carries the tenant slug:

- `cupboard push` uploads a store path closure and optionally pins it.
- `cupboard cache`, `cupboard policy`, and `cupboard root` manage named caches
  and what is kept.
- `cupboard key` and `cupboard auth-key` rotate the tenant's signing keys.
- `cupboard oidc-trust` configures which CI workflows may push.

## URL forms

A command's URL says what it acts on. Operator and control-plane commands take
the deployment's bare host:

```
https://cupboard.example.workers.dev
```

Tenant-scoped commands take that host with the tenant's slug appended:

```
https://cupboard.example.workers.dev/t/acme
```

The default cache is implied by the bare tenant URL; a named cache is selected
with `--cache <name>` where the command supports it.

## Getting started

Stand up a deployment, provision a tenant, then push to it:

```sh
# Operator: deploy, then create a tenant. The --owner-* values are the OIDC
# identity allowed to administer the tenant: the same identity its admin
# presents to `cupboard login`.
cupboard init
cupboard tenant create https://cupboard.example.workers.dev acme \
  --owner-issuer <issuer> --owner-subject <subject> --owner-audience <audience>

# Tenant admin: sign in, then push
cupboard login https://cupboard.example.workers.dev/t/acme
cupboard push https://cupboard.example.workers.dev/t/acme ./result

# Print the nix.conf a client needs to substitute from the tenant
cupboard config https://cupboard.example.workers.dev/t/acme \
  "$(cupboard pubkey https://cupboard.example.workers.dev/t/acme)"
```

Most commands need a session first; `cupboard login <url>` caches an admin token
for the tenant. Pushing from CI instead uses GitHub Actions OIDC with
`cupboard push --github-oidc`, trusted through `cupboard oidc-trust`.

## Output modes

Every command renders one of two ways. Attached to a terminal it shows progress
spinners, prompts, and result tables. Piped or in CI it emits line-delimited
JSON on stderr, with command payloads (a public key, a `nix.conf`) on stdout, so
output can be parsed or redirected:

```sh
cupboard pubkey https://cupboard.example.workers.dev/t/acme > key.pub
cupboard --no-colour tenant list https://cupboard.example.workers.dev \
  | jq -c 'select(.event == "result").data'
```

Pass `--colour` or `--no-colour` to force a mode.

## More

- [docs/github-actions.md](./docs/github-actions.md) sets up building,
  attesting, and pushing outputs from GitHub Actions.
- [AGENTS.md](./AGENTS.md) describes the repository layout and conventions.
- [PLAN.md](./PLAN.md) tracks the feature plan and progress.

[Nix]: https://nixos.org
[Cloudflare Workers]: https://workers.cloudflare.com
