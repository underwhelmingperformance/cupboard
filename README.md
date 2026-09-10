# cupboard

cupboard is a multi-tenant [Nix] binary cache that runs on [Cloudflare Workers].
It serves store paths over the standard Nix binary-cache protocol, backed by R2
for NAR bytes and a Durable Object per tenant for the metadata, signing keys,
and retention bookkeeping. One deployment hosts many independent tenants, each
with its own caches, keys, and access rules.

The `cupboard` CLI provisions and operates a deployment. It pushes store paths,
manages tenants and their keys, configures retention, and prints the `nix.conf`
a client needs to substitute from a cache.

## Two roles

The commands fall into two groups: operating the deployment and administering
one of its tenants.

An **operator** owns the deployment. They provision it, create and offboard
tenants, and manage the control-plane signing keys. These commands address the
deployment by its bare host and are marked "operator only" in the help:

- `cupboard init` (alias `cupboard deploy`) provisions the Workers, R2 bucket,
  D1 database, and queues on a Cloudflare account.
- `cupboard tenant` creates, suspends, resumes, and removes tenants, and rotates
  the read credential of a tenant or of one of its private caches.
- `cupboard control-key` rotates the keys that sign control-plane tokens.

A **tenant admin** owns one tenant within a deployment. They push paths, manage
the tenant's caches and retention, and rotate the keys that sign its narinfos.
These commands address the tenant through a URL that includes its slug:

- `cupboard push` uploads store paths (their complete closure with `--closure`)
  and optionally pins them.
- `cupboard cache` manages caches and their retention properties.
  `cupboard root` manages what each cache keeps.
- `cupboard key` rotates a tenant's narinfo signing keys and reports background
  re-signing progress. `cupboard auth-key` rotates its access-token keys.
- `cupboard oidc-trust` configures which CI workflows may push.
- `cupboard stats` reports a cache's objects and the tenant's charged storage,
  `cupboard delete` removes a single store path, and `cupboard check` audits
  stored objects against their committed metadata.

## URL forms

The URL passed to a command identifies its target. Operator and control-plane
commands take the deployment's bare host:

```
https://cupboard.example.workers.dev
```

Tenant-scoped commands take that host with the tenant's slug appended:

```
https://cupboard.example.workers.dev/t/acme
```

The bare tenant URL selects the default cache. A named cache has the stable URL
`/t/acme/cache/<name>`. Commands accept that URL directly. Where a command also
takes values such as local paths, it can instead take the bare tenant URL and
the cache name as the next positional argument.

Each cache has an `access` property. A private cache uses the same stable URL
and authenticates reads with the tenant-wide fallback credential or with a
credential of its own; see [Private caches][cache-access].

[cache-access]: ./docs/nix.md#private-caches

## Getting started

Stand up a deployment, provision a tenant, then push to it:

```sh
# Deploy, then create a tenant. The --owner-* values identify the OIDC
# principal that may administer it and sign in with `cupboard login`.
cupboard init --instance-name cupboard
cupboard tenant create https://cupboard.example.workers.dev acme \
  --owner-issuer <issuer> --owner-subject <subject> --owner-audience <audience>

# Sign in as the tenant administrator, then push.
cupboard login https://cupboard.example.workers.dev/t/acme
cupboard push https://cupboard.example.workers.dev/t/acme ./result

# Print the nix.conf required to substitute from the tenant.
cupboard config https://cupboard.example.workers.dev/t/acme \
  "$(cupboard pubkey https://cupboard.example.workers.dev/t/acme)"
```

Most commands need a session first; `cupboard login <url>` caches an admin token
for the tenant. Pushing from CI instead uses GitHub Actions OIDC with
`cupboard push --github-oidc`, trusted through `cupboard oidc-trust`.

The instance name is immutable after the first successful initialisation. Pass
`--instance-name` to choose it. If the option is omitted, the CLI derives a
stable `cupboard-<hash>` name from the deployment's public origin. The name
forms the first component of each new Nix signing-key name:
`<instance>-<tenant>-<generation>`. Hyphens inside the instance and tenant
components are doubled so the complete name is unambiguous. A rotation keeps
both keys signing while existing narinfos are re-signed in the background:

```sh
cupboard key rotate https://cupboard.example.workers.dev/t/acme
cupboard key status https://cupboard.example.workers.dev/t/acme
cupboard key retire https://cupboard.example.workers.dev/t/acme active
```

Add the incoming key to every client's `trusted-public-keys`, then wait for its
backfill to complete before retiring the outgoing key. The first retirement
demotes the outgoing key to published-only. Nix caches successful narinfo
lookups, including their signatures, for `narinfo-cache-positive-ttl`; the
default is 30 days. Keep the outgoing key in each client's `trusted-public-keys`
until that client's cache window has elapsed since the last old-only response it
could have fetched, or clear the client's narinfo cache. The server cannot infer
a client's configured TTL. A second retirement removes the key from `/pubkey`,
but `/pubkey` does not change any client's trust configuration. If the backfill
cannot complete, `cupboard key abort <url> <incoming-id>` removes the incoming
key and its unfinished work.

## Output modes

Every command supports two output modes. Attached to a terminal it shows
progress spinners, prompts, and result tables. Piped or in CI it emits
line-delimited JSON on stderr, with command payloads (a public key, a
`nix.conf`) on stdout, so output can be parsed or redirected:

```sh
cupboard pubkey https://cupboard.example.workers.dev/t/acme > key.pub
cupboard --output-mode json tenant list https://cupboard.example.workers.dev \
  2>&1 | jq -c 'select(.event == "result").data'
```

Pass `--output-mode terminal` or `--output-mode json` to force the mode. Colour
is a separate choice: `--colour` and `--no-colour` force ANSI on or off, and
`NO_COLOR` is honoured otherwise.

## Exit codes for `cupboard build-push`

`cupboard build-push` streams publication while the build runs, then reconciles
the final build and publication results. Its numeric exit status lets retry
systems distinguish build failures from publication and retention failures
without parsing output. A build failure returns the build command's status, or
128 plus the signal number. If the build succeeds but publication or retention
fails, the command returns a sysexits status. The receipt records both causes
when both phases fail.

The build command must use the inherited Nix store configuration. Do not pass
`--store` to a nested Nix command or change `NIX_REMOTE`. Cupboard cannot
protect or publish outputs from another store.

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | The build succeeded and every selected path is published.            |
| 1-n  | The build command itself failed; its own exit status passes through. |
| 69   | A dependency the run needs is unavailable (`EX_UNAVAILABLE`).        |
| 74   | A publication failure not otherwise classified (`EX_IOERR`).         |
| 75   | A transient failure; retrying the run may succeed (`EX_TEMPFAIL`).   |
| 77   | An authentication or authorisation failure (`EX_NOPERM`).            |
| 130  | The run was interrupted; reserved for abort.                         |

Other commands share the 69, 75 and 77 categories; 74 is specific to
`build-push`, whose publication phase never exits with a bare 1.

## More

- [docs/github-actions.md](./docs/github-actions.md) sets up building,
  attesting, and pushing outputs from GitHub Actions.
- [docs/nix.md](./docs/nix.md) installs the CLI with Nix and adds a cache as a
  substituter.
- [docs/measuring-realisation.md](./docs/measuring-realisation.md) measures what
  publishing a flake's targets costs a cold runner, and gates that cost.
- [AGENTS.md](./AGENTS.md) describes the repository layout and conventions.
- [PLAN.md](./PLAN.md) tracks the feature plan and progress.

[Nix]: https://nixos.org
[Cloudflare Workers]: https://workers.cloudflare.com
