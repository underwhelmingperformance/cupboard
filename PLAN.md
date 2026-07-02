# `cupboard` Plan

A Cloudflare Workers substituter for Nix.

## Non-Goals

- Federation, mirroring, or peer-to-peer between deployments.
- Replacing Hydra, Cachix, or Attic at organisational scale.
- Acting as a general HTTP file host. Only Nix store paths and their metadata.

## Tenancy

Multi-tenant. One operator runs the instance and onboards independent,
mutually-distrusting tenants. Each tenant has its own owner, signing keys, OIDC
trust rules, retention roots, narinfo metadata, and storage accounting. NAR
bytes sit underneath that in a shared, content-verified CAS.

Tenancy is structural, not just intent. A tenant is addressed by a slug in the
URL path, `https://<host>/t/<tenant>/...`, and is backed by one `CupboardServer`
Durable Object addressed by `idFromName(<tenant>)`. That DO owns the tenant's
SQLite database: its narinfos, roots, signing keys, auth keys, OIDC trust rules,
and identity, none of which crosses a tenant boundary. The bare host serves only
the control surface and no cache content. Named caches and per-repository write
scopes are organisation _within_ one tenant's trust domain, not isolation
between tenants; the tenant boundary is the DO.

The control plane is a Hono coordinator on the Worker, not a Durable Object.
Global state lives in D1 (the tenant registry, per-narinfo reference edges, the
shared blob set, the control-plane signing keys, the global-admin record, and
per-tenant usage and quota), with a versioned KV manifest as the admission
read-cache. The control plane is its own OAuth issuer, separate from every
tenant issuer, and the only holder of `CONTROL_KEY_WRAP_SECRET`, so a tenant DO
cannot unwrap the control signing key it can read from shared D1.

## Compatibility

- Develop and test against the current Nix the e2e suite is run with (2.33, via
  Determinate Nix, at the time of writing); that is the only version cupboard is
  verified against, and there is no compatibility guarantee for older releases.
  Supporting older clients is an explicit non-goal. zstd-compressed NARs are the
  obvious hard cliff — Nix only gained zstd substitution in 2.4 (November 2021),
  so anything older could not substitute at all — but the point is broader: we
  do not certify a minimum version, and adding fallback NAR compression for old
  clients is not worth it for a personal cache.
- The CLI drives the write path. Pure TypeScript code serialises NARs, computes
  hashes, compresses blobs, and speaks the cupboard upload protocol. The CLI
  negotiates, prepares an upload, uploads the blob to a presigned R2 PUT, and
  awaits the server's commit verdict; verification and promotion into
  `blob_state` are server-side. The only local Nix dependency is a daemon client
  used to query valid path metadata and closure membership. The Worker owns
  authentication, R2 presigned URL generation, signing, and metadata commit. The
  CLI never receives R2 credentials.
- Signing uses the standard Ed25519 narinfo format so any Nix client with the
  public key in `trusted-public-keys` can verify substitutions. Each tenant
  signs with its own key, so a substituter trusts a tenant only via that
  tenant's published key.

## Current state

The multi-tenant model described above is live on the `hono-orpc-refactor`
branch, not deferred. The V1-V4 sections below record how the single-cache,
single-owner cache was built up; the V5 section describes the multi-tenant
target, which is now implemented. The early "single-tenant for now" framing has
been overtaken by that work. Routing is Hono throughout, and the JSON admin APIs
are contract-first oRPC: every admin procedure is declared once in
`@cupboard/protocol/contract`, the server implements it with oRPC, and the CLI
derives its typed clients from it. Only wire-format endpoints (`pubkey`,
`signup`, the commit WebSocket, public reads, private Basic auth) stay outside
the contract.

## V1

V1 is a single-cache personal binary cache. It should be enough to push a store
path with `cupboard`, configure Nix with the printed substituter settings, and
successfully substitute that path from the Worker.

### Read path

- [x] Serve a valid Nix binary cache:
  - [x] `/nix-cache-info`, carrying `StoreDir: /nix/store`, `WantMassQuery: 1`,
        and a `Priority`.
  - [x] `/<hash>.narinfo` with an Ed25519 signature over the standard
        fingerprint `1;StorePath;NarHash;NarSize;Refs...`.
  - [x] `/nar/<narHash>.nar.zst` for the compressed NAR blob.
- [x] Support `GET` and `HEAD` for cache-info, narinfo, and NAR blob routes.
- [x] Emit `References:` as space-separated basenames, not full store paths.
- [x] Allow public unauthenticated reads, since Nix substituters usually need
      simple HTTP access.
- [x] Tests:
  - [x] Unit: `nix-cache-info` serialiser; narinfo serialiser and parser
        round-trip; fingerprint construction; generated valid narinfo
        round-trips with `fast-check`.
  - [x] Unit: `fast-check` parser permissiveness properties for field order,
        optional fields, and blank lines.
  - [x] Integration: GET each route returns the expected body and headers; HEAD
        returns the same headers with no body. Unknown hash returns 404 and a
        signed narinfo verifies against the published pubkey.

### Write path

- [x] Push store paths from a companion CLI.
- [x] Compress NARs with zstd by default at upload time, and record
      `Compression`, `FileHash`, and `FileSize` for the compressed blob
      alongside the uncompressed `NarHash` and `NarSize`.
- [x] Authenticate write and admin operations with short-lived cupboard JWTs.
      The deploy-time bootstrap secret is accepted only by `/auth/bootstrap`.
- [x] Validate uploaded NAR metadata:
  - [x] required: store path hash, NAR hash, NAR size, references
  - [x] optional: deriver and CA fields
- [x] Upload large NARs directly to R2 via Worker-generated R2 S3 presigned PUT
      URLs. Streaming bodies through the Worker request is not an option given
      Workers' body-size and CPU limits; this is a hard requirement, not a
      "where possible".
- [x] Provide deterministic, resumable-ish upload behaviour:
  - [x] client computes the uncompressed NAR hash and size
  - [x] server tells the client which blobs are missing
  - [x] client uploads missing content directly to R2 with an R2-validated
        SHA-256 checksum header
  - [x] server commits metadata once R2 confirms the blob is present
- [x] Tests:
  - [x] Unit: NAR metadata validation (hash, size, references); rejecting
        narinfos missing required fields; recording compressed-blob metadata
        alongside uncompressed.
  - [x] Integration: full upload flow (negotiate, presigned PUT, commit)
        produces a fetchable narinfo; re-uploading an already-present path is a
        no-op; the pending row is created on negotiate and cleared on commit;
        commit rejects missing or mismatched R2 SHA-256 checksums.

### Client

- [x] Configure against a personal Worker URL and bootstrap secret.
- [x] Compute NAR hash and size locally while streaming the same NAR into zstd,
      so each path is read once.
- [x] Upload only missing blobs.
- [x] Show progress through a `Reporter` abstraction with two renderers,
      auto-selected from `stderr.isTTY`:
  - [x] Terminal: `ora` spinners, `picocolors` for ANSI, `cli-table3` for result
        blocks. One phase per logical step (resolve closure, negotiate, prepare
        missing NARs, upload, commit), each collapsing to one line on completion
        with inline facts.
  - [x] JSON: line-delimited events for CI logs and piping to `jq`. Event types
        are `phase`, `result`, `warn`, and `info`; phase events carry `status`,
        `durationMs`, and a `facts` object.
- [x] `--colour` / `--no-colour` flags override the TTY auto-detection.
- [x] Print Nix configuration:
  - [x] `substituters = ...`
  - [x] `trusted-public-keys = ...`
- [x] Tests:
  - [x] Unit: locally-computed NAR hash and size match what `nix-store --dump`
        produces (run against fixture paths); substituter config rendering.
  - [x] E2E: push a fixture, configure a clean tmp Nix store with the
        substituter URL and public key, substitute the path back, assert the
        signature verifies. This is the Tier 3 golden-path scenario.

### Storage

- [x] Store metadata in one Durable Object SQLite database.
- [x] Store binary content in R2, keyed by the uncompressed NAR hash. A metadata
      row maps `narHash` to the actual stored blob path (for example
      `nar/<narHash>.zst`).
- [x] One cache, served at the Worker root; named caches are a V3 concern.
- [x] Tests:
  - [x] Integration: schema initialises on first request; metadata-to-blob
        mapping survives committed reads and blob reuse. Concurrent writes and
        explicit DO eviction coverage are V3 hardening.

### Signing

- [x] Generate the Ed25519 signing keypair during initialisation and persist the
      private key in a DO row, not a Workers secret, so it survives redeploys.
- [x] Expose the public key via the admin command and an unauthenticated
      `GET /pubkey` route.
- [x] Tests:
  - [x] Unit: signature verification round-trip; key generation produces a valid
        Ed25519 keypair.
  - [x] Unit: signature matches a known fixture for a fixed key and standard Nix
        fingerprint.
  - [x] Integration: `GET /pubkey` returns the active key; first-request key
        generation persists across repeated requests. Explicit DO eviction
        coverage is V3 hardening.

### Garbage collection

- [x] Use Cron Triggers for the GC pass. DO alarms are reserved for per-cache
      work that needs the DO's state mid-run.
- [x] Clean abandoned pending uploads after a grace window.
- [x] Delete abandoned pending-upload blobs that have no committed narinfo rows.
- [x] Tests:
  - [x] Integration: `pending_upload` rows past the grace window are cleared;
        orphaned R2 blobs for expired pending uploads are deleted; committed
        blobs are retained.
  - [x] Integration: the cron trigger invokes the scheduled handler with the
        correct env. Committed blob deletion waits for retention roots.

### Admin

- [x] Initialise deployment: ensure the signing key and mint an admin JWT from
      the bootstrap secret.
- [x] Print Nix substituter config for the user's `nix.conf`.
- [x] Show the public signing key.
- [x] Inspect cache stats.
- [x] Tests:
  - [x] Unit: substituter config command renders a correct `nix.conf` snippet
        for a given Worker URL and pubkey.
  - [x] Integration: bootstrap mints an admin JWT and keeps the signing key
        stable across calls; stats returns accurate row counts.

### Onboarding

One command takes an operator from nothing to a usable cache, and the identity
that deployed is the identity that administers.

- [x] `cupboard init` (alias `deploy`): build, authenticate via cupboard's
      public Cloudflare OAuth client (PKCE loopback on registered ports; grant
      cached with owner-only permissions and renewed from its refresh token),
      review an editable plan (account, custom domain, resource names, cron
      triggers, admin), settle R2 credentials (created as a bucket-scoped
      account-owned API token where the deploy credential may manage tokens,
      rolled on re-deploys; entered manually otherwise; probed with a signed
      HEAD before anything deploys), then provision.
- [x] Two-step initialisation after the deploy. Step one: resolve the deployment
      URL (custom domain, read back from the routing on re-runs, or the
      workers.dev subdomain with the script route enabled) and poll the
      unauthenticated `/_version` route until it answers with the build just
      uploaded, since an older Worker version (with the old configuration) can
      keep answering while the new one propagates. Step two: claim global admin
      at `POST /signup` with the deployer's id_token (idempotent for the same
      principal; a `CUPBOARD_SIGNUP_SECRET` on the Worker is presented too,
      prompted for when only the Worker knows it), exchange it for an admin
      token and cache that token, prompt for the first cache's slug (typed
      inline after the `<url>/t/` prefix; no default), create the tenant, and
      poll its `/t/<slug>/pubkey` (whose first success creates the signing key)
      before printing the `nix.conf` lines for the cache URL. The create call is
      the arbiter of slug ownership: a conflict re-prompts, and re-creating an
      identical tenant is idempotent, so re-runs converge.
- [x] Admin binding: the deploy seeds the control Worker's signup gate
      (`CUPBOARD_SIGNUP_*`) from the plan's Admin choice. The default is the
      configured vars, then the deployer's Cloudflare identity
      (`https://dash.cloudflare.com` is a compliant OIDC issuer; the id_token's
      `sub` arrives with the `openid` scope; the audience is cupboard's client
      id), then nobody, with a warning that the gate stays closed. A gate naming
      someone else leaves the claim to them.
- [x] `cupboard login` defaults to the same issuer and client, so a flagless
      login presents exactly the triple the owner rule pins. `--headless` uses
      the RFC 8628 device flow (the OAuth client carries the device code grant
      type); a refused device authorization names the grant to enable.
- [x] Plans adapt to the account: the Free plan rejects the `limits` field, so
      uploads retry without CPU limits and warn; Cloudflare API errors end the
      deploy with the response's human-readable detail, exit code 1.

### Test harness

- [x] Tier 1 runs on per-package Vitest defaults (`*.test.ts` alongside the
      code); only `packages/server` needs its own config, for the Tier 2 Worker
      pool. No separate workspace-root setup is required.
- [x] `@cloudflare/vitest-pool-workers` configured in `packages/server` for Tier
      2, picking up `*.workers.test.ts` only so the unit run is not slowed by
      Worker boot.
- [x] `fast-check` added as a dev dependency for property tests.
- [x] Fixture generation script that runs `nix-store --dump` against a small set
      of synthetic store paths; outputs committed under `tests/fixtures/`.
- [x] E2E harness under `tests/e2e/`: clean-env Miniflare Worker runner, local
      HTTP server for Nix, scoped `nix` invocation builder, and localhost URL
      validation. Enforces the Isolation invariants documented in the Testing
      section.
- [x] `pnpm test:e2e` script wired at the root.

## Infrastructure

Cross-cutting concerns not tied to a single V1 sub-section. Bindings, cron, and
operational endpoints live with the features that use them.

- [x] Wrangler-based deployment.
- [x] Cache-friendly read responses:
  - [x] stable URLs
  - [x] ETag
  - [x] `Cache-Control`
  - [x] conditional request support if cheap
- [x] Tests:
  - [x] Integration: `ETag` and `Cache-Control` present on narinfo and NAR
        responses; a conditional GET with matching `If-None-Match` returns 304;
        matching `If-Modified-Since` likewise.

## Data Model

One DO SQLite database per deployment.

- `narinfo` — one row per store path per cache.
  - (`cache`, `store_path_hash`) (PK), `store_path`, `nar_hash`, `nar_size`,
    `file_hash`, `file_size`, `compression`, `references_json`, `deriver`, `ca`,
    `sigs_json`, `created_at`. The `cache` is the empty default cache or a named
    one; the narinfo R2 object is namespaced under the cache.
- `nar_blob` — one row per stored compressed blob.
  - `nar_hash` (PK), `r2_key`, `compression`, `file_hash`, `file_size`,
    `created_at`.
- `pending_upload` — in-flight uploads not yet committed.
  - `id` (PK), `cache`, `nar_hash`, `r2_key`, `expected_size`, `metadata_json`,
    `created_at`, `expires_at`. The `cache` binds the upload to the cache it was
    negotiated under, so a prepare or commit cannot redirect it.
- `orphan_blob_deletion` — durable queue for deleting abandoned R2 objects.
  - `r2_key` (PK), `not_before`, `created_at`.
- `narinfo_deletion` — durable queue for finishing interrupted narinfo removals.
  - (`cache`, `store_path_hash`) (PK), `nar_hash`, `created_at`.
- `retention_root` — a named channel of kept store paths, optionally expiring.
  - (`cache`, `name`) (PK), `expires_at` (nullable), `created_at`, `updated_at`.
- `retention_root_target` — the store paths a channel currently keeps.
  - (`cache`, `root_name`, `store_path_hash`) (PK), `store_path`.
- `retention_policy` — default TTLs supplied to roots created without one.
  - `id` (PK), `scope` (`cache` or `root-name-prefix`), `pattern`,
    `default_ttl_seconds`, `created_at`. The most specific match wins.
- `cache` — the named-cache registry; the empty name is the default cache.
  - `name` (PK), `priority`, `created_at`.
- `verification_cursor` — where the background verify pass last stopped.
  - `id` (PK, single `active` row), `cache`, `last_store_path_hash` (nullable),
    `updated_at`. Holds a composite `(cache, store_path_hash)` position; empty
    restarts the scan at the first cache's lowest hash.
- `auth_key` — deployment-owned signing keys for cupboard access JWTs, a
  rotatable set.
  - `id` (PK), `kid`, `private_jwk_json`, `public_jwk_json`, `created_at`,
    `retired_at` (nullable). The newest non-retired key mints; every non-retired
    key verifies, and the JWKS publishes each one by its `kid`.
- `oidc_trust` — OIDC trust rules that federate an external identity into a
  cupboard scope.
  - `id` (PK), `issuer`, `audience`, `scope` (`write` or `admin`), `claims_json`
    (exact-match policy), `allowed_roots_json` (write rules), `created_at`,
    `disabled_at` (nullable). The issuer's `jwks_uri` and accepted signing
    algorithms are discovered from its OIDC metadata, not stored. The owner's
    `admin` rule is seeded from deploy config; `write` rules are managed through
    the admin API.

## Routes

Public reads and health/version endpoints are served by the Worker from R2 and
the Cache API where possible; the Durable Object handles auth, writes, admin,
and GC routes.

| Method    | Path                                      | Auth               | Notes                                           |
| --------- | ----------------------------------------- | ------------------ | ----------------------------------------------- |
| GET, HEAD | `/nix-cache-info`                         | public             | Worker; `text/x-nix-cache-info`.                |
| GET, HEAD | `/<hash>.narinfo`                         | public             | Worker, from the R2 object + edge cache.        |
| GET, HEAD | `/nar/<hash>.nar.zst`                     | public             | Worker, from R2 + edge cache.                   |
| GET       | `/pubkey`                                 | public             | Worker, cached from the DO.                     |
| GET, HEAD | `/.well-known/jwks.json`                  | public             | Worker, from the DO. Auth public keys (`kid`).  |
| GET       | `/.well-known/oauth-authorization-server` | public             | Worker. RFC 8414 metadata.                      |
| GET       | `/_health`                                | public             | Worker. Liveness.                               |
| GET       | `/_version`                               | public             | Worker. Git SHA, `+dirty` when dirty.           |
| POST      | `/token`                                  | OIDC subject token | DO. RFC 8693 exchange; mints a write/admin JWT. |
| GET       | `/stats`                                  | admin JWT          | DO. Cache size and object count.                |
| GET       | `/keys`                                   | admin JWT          | DO. Lists the narinfo signing key set.          |
| POST      | `/keys/rotate`                            | admin JWT          | DO. Adds a signing+published key.               |
| POST      | `/keys/retire/<id>`                       | admin JWT          | DO. Demotes a key, then drops it.               |
| GET       | `/keys/auth`                              | admin JWT          | DO. Lists the auth signing-key set.             |
| POST      | `/keys/auth/rotate`                       | admin JWT          | DO. Adds a new active auth key.                 |
| POST      | `/keys/auth/retire/<kid>`                 | admin JWT          | DO. Retires an auth key by `kid`.               |
| DELETE    | `/paths/<hash>`                           | admin JWT          | DO. Deletes one store path; defers its NAR.     |
| GET       | `/roots`                                  | admin JWT          | DO. Lists retention roots.                      |
| PUT       | `/roots/<encoded-name>`                   | write JWT          | DO. Creates or replaces a retention root.       |
| DELETE    | `/roots/<encoded-name>`                   | admin JWT          | DO. Removes a retention root.                   |
| POST      | `/uploads`                                | write JWT          | DO. Returns skip, commit, or upload plans.      |
| PUT       | `/uploads/<id>`                           | write JWT          | DO. Returns R2 PUT URL and headers.             |
| PUT       | (presigned R2 URL)                        | URL                | Client uploads blob directly to R2.             |
| GET (WS)  | `/uploads/<id>/commit`                    | write JWT          | DO. WebSocket; parks until the verdict settles. |
| POST      | `/gc`                                     | admin JWT          | DO. Runs pending-upload, retention, and R2 GC.  |
| GET       | `/caches`                                 | admin JWT          | DO. Lists the cache registry with counts.       |
| PUT       | `/caches/<name>`                          | admin JWT          | DO. Upserts a named cache's priority.           |
| DELETE    | `/caches/<name>`                          | admin JWT          | DO. Tears a cache down (`?force` if non-empty). |
| GET       | `/policies`                               | admin JWT          | DO. Lists retention policies.                   |
| POST      | `/policies`                               | admin JWT          | DO. Adds a retention policy.                    |
| DELETE    | `/policies/<id>`                          | admin JWT          | DO. Removes a retention policy.                 |
| GET       | `/oidc-trust`                             | admin JWT          | DO. Lists OIDC trust rules.                     |
| POST      | `/oidc-trust`                             | admin JWT          | DO. Adds a write trust rule.                    |
| DELETE    | `/oidc-trust/<id>`                        | admin JWT          | DO. Soft-disables a trust rule.                 |
| GET       | `/check`                                  | admin JWT          | DO. Read-only storage check (`?deep`).          |
| POST      | `/verify`                                 | admin JWT          | DO. One reconciling pass (`?limit`).            |

Every path-scoped read and write route also has a `/cache/<name>/` form
selecting a named cache, with the same auth as its bare twin: the narinfo, NAR,
nix-cache-info and pubkey reads and the `stats`, `paths`, `roots`, `uploads` and
`gc` routes. The bare routes serve the empty default cache. A named cache's
nix-cache-info is rendered by the DO from its registered priority; its narinfo
objects are namespaced in R2, while NAR blobs stay shared. The `/token`,
`/.well-known/*`, `/caches` registry, `/policies`, `/oidc-trust`, `/keys/auth`,
`/check` and `/verify` routes are deployment-wide and take no prefix; `/check`
and `/verify` span every cache, since NAR blobs are shared.

Root names in `PUT`/`DELETE /roots/<encoded-name>` live only in the path. The
request body for `PUT` is `{ targets, ttlSeconds? }`; the server combines that
body with the decoded path segment and validates the full root request. Worker
integration tests cover names containing `/` and `%`, so callers must URL-encode
the name as one path segment.

## Testing

Tests live in three tiers. Per-feature test items live with the V1 features that
need them; this section pins down what each tier is for, how Tier 3 stays
sandboxed, where fixtures live, and the cross-cutting principles.

### Tier 1: unit (Vitest)

Pure functions in either package. No Worker runtime, no I/O. TDD-friendly. Lives
as `*.test.ts` alongside the code.

### Tier 2: Worker integration (`@cloudflare/vitest-pool-workers`)

Real `workerd`, real DO SQLite, real R2, all in-process. No mocking of
Cloudflare primitives. Lives as `*.workers.test.ts` under `packages/server/src/`
so the unit run does not pick them up.

### Tier 3: end-to-end with a real `nix` client

Runs the Worker in Miniflare behind a local HTTP server and drives a real `nix`
against fixture store paths. Catches protocol drift (wrong header, fingerprint
typo, missing `Compression` field) that internal contract tests cannot catch.
Lives under `tests/e2e/`, invoked via `pnpm test:e2e`. Runs in CI; the CI image
installs Nix, pinned to a specific version so the gate matches the version named
in Compatibility rather than drifting with whatever the runner ships.

#### Isolation

E2E tests must be incapable of touching a deployed cupboard or the developer's
local `/nix/store`, even if the surrounding shell has production credentials or
Nix configuration. Enforced by the harness, not by convention.

- [x] All child processes (`nix`, `nix-store`, and fixture helpers) spawn with
      an explicitly constructed env containing only `PATH`, a per-test temporary
      `HOME`, and variables the test sets deliberately. The parent `process.env`
      is not inherited.
- [x] The Worker runs in local Miniflare, fronted by a test-owned HTTP server.
      There is no code path from a test to a real deployment.
- [x] `nix` invocations get `--store local?root=<tmpdir>`,
      `NIX_USER_CONF_FILES=/dev/null`, and `NIX_CONF_DIR=<tmpdir>/etc` so they
      cannot read or write the developer's `/nix/store` or pick up their
      substituter config.
- [x] Cupboard URLs are produced by the local test server and rejected unless
      the host is `127.0.0.1` or `localhost`.

### Fixtures

- [x] Generate a small synthetic store path once with `nix-store --dump`. Commit
      it as a binary fixture under `tests/fixtures/`.
- [x] Unit tests parse them; integration and E2E tests push and re-fetch them.

### Principles

- No mocking of R2, DO, KV, or other Cloudflare primitives. Restructure via
  dependency injection at interface boundaries instead.
- No coverage percentage targets. The targets that matter: every pure function
  has unit tests; every route, GC pass, and signing path has at least one
  integration test; the E2E suite covers push and substitute against a real
  `nix`.
- Prefer structural assertions on parsed objects over golden files, with one
  golden per representative narinfo to catch serialisation drift.

## V2

V1 routes every request through the single `CupboardServer` Durable Object,
including reads that do no database work. Because there is one DO per
deployment, every narinfo and NAR fetch is serialised through that instance and
pays the migration check on entry. R2 and the Cache API scale horizontally and
serve from the edge, so the read path should not touch the DO at all.

V2 moves all reads onto the Worker, backed by R2 and `caches.default`. The DO
keeps the write path (negotiate, prepare, commit), admin, and GC. The narinfo
row stays in DO SQLite because reference-graph GC needs to query it; it just
stops being read on the hot path. A narinfo is rendered and signed once at
commit time and written to R2, so reads never re-render or re-sign.

This relies on one invariant: a narinfo for a given store path hash is
immutable. Nix derives the hash from the path's inputs and contents, so the same
hash always maps to the same narinfo. Deliberately deleting committed content is
the only mutation that needs edge-safe handling, and V2 has no path that does
so, so that machinery moves to V3 alongside reference-graph GC; V2 only cleans
up the narinfo object when a path's NAR has already vanished (stale recovery).

### Worker read routing

- [x] Add `packages/server/src/read.ts` owning the read routes. `handler.ts`
      tries it first and forwards everything else to the DO stub. Thread `ctx`
      into the Worker `fetch` so cache writes can use `ctx.waitUntil`.
- [x] Move `parseNarName`, `parseNarInfoName`, and the conditional-request
      helper (`isNotModified`) out of `do.ts` into a place `read.ts` can share.
- [x] Remove the `/nar/:narName` and `/:narInfoName` routes, and the
      `narResponse` and `narInfoResponse` methods, from the DO once the Worker
      owns them.
- [x] Serve the static read routes (`/nix-cache-info`, `/_health`, `/_version`,
      `/pubkey`) from the Worker. `/pubkey` is forwarded to the DO uncached so a
      key rotation is visible immediately; the DO sets `no-cache` with a strong
      ETag so Nix still revalidates conditionally (see Signing, below).
- [x] Only `GET` responses go into `caches.default`. `HEAD` is answered from R2
      metadata (`BLOBS.head`) with no body and is never cached, since caching
      HEAD responses invites body and header mismatches.

### NAR blobs from R2 and the edge

- [x] Serve `GET` `/nar/<narHash>.nar.zst` in the Worker: check
      `caches.default`, then `BLOBS.get`, building the existing `immutable`
      response from the R2 object metadata (ETag, uploaded, size). On a miss,
      populate the cache with `ctx.waitUntil(caches.default.put(...))`. `HEAD`
      is answered from `BLOBS.head` without touching the cache.
- [x] Keep conditional `If-None-Match` and `If-Modified-Since` 304 handling.
- [x] NAR objects are content-addressed and immutable, so edge copies never need
      invalidation; deleting one only frees R2 storage. `/nar/<hash>` stays
      public and is guessable by anyone who knows the hash, so the safety
      property GC must preserve is not "narinfo gates access" but the narrower:
      a stale cached narinfo must not point at a deleted NAR before its TTL
      expires (see TTL-ordered garbage collection).
- [x] Tests:
  - [x] Integration: GET and HEAD return the expected bytes and headers through
        the Worker entrypoint; an unknown hash is 404; conditional GETs
        return 304. Assert correctness rather than cache hits, since the test
        pool's Cache API may not surface them.

### narinfo from R2 and the edge

- [x] On a genuine first commit, render and sign the narinfo (the signature is
      already computed for the DB row) and `BLOBS.put` it at
      `narinfo/<storePathHash>` with `text/x-nix-narinfo` and a `Cache-Control`
      max-age. The NAR blob is already present at commit, so a served narinfo
      never points at a missing NAR.
- [x] Enforce immutability as structure, not comment: a commit for a
      `storePathHash` that already has a row returns `already-present` and
      rewrites neither the DB row nor the R2 object. `handleCommit` already
      short-circuits here, so make `commitMetadata`'s narinfo write
      `onConflictDoNothing` rather than `onConflictDoUpdate`, and only
      `BLOBS.put` the narinfo on a genuine first commit. Two commits for one
      hash rendering different bytes is impossible by Nix construction
      (different contents mean a different hash), so no byte-comparison is
      needed.
- [x] The narinfo DB row is the source of truth; the `narinfo/<storePathHash>`
      R2 object is a materialised, regenerable cache of it. The row carries
      every field including the signature, and rendering is deterministic, so
      re-materialising is byte-identical. Reads serve the object; truth and
      queryability stay in the row.
- [x] Never advertise a path as present without a servable object, but do not
      try to make the two writes atomic with a rollback — a crash between the
      row commit and the rollback cannot be covered. Lean on regenerability
      instead: on commit write the row, then materialise the object; if the put
      fails or the DO is evicted, the row persists and the object is re-derived
      later. Close the window deterministically by re-materialising from the row
      in both places that can report a path already present: negotiate before it
      returns `skip`, and commit before it returns `already-present`. Each heads
      the object and regenerates it from the row when missing, so neither exit
      can advertise an unservable path. An only-if-absent conditional put
      (`onlyIf`, semantics to confirm) is an optional guard, not a correctness
      requirement, since determinism makes any overwrite byte-identical.
- [x] Serve `GET` `/<storePathHash>.narinfo` in the Worker from R2 via
      `caches.default`, with ETag, last-modified, and 304 driven by the R2
      object; `HEAD` from `BLOBS.head` without caching.
- [x] Stop reading the narinfo row on the read path; it remains only for GC and
      stats.
- [x] Tests:
  - [x] Integration: commit writes the R2 object; the Worker serves it and the
        signature verifies against the published pubkey; 404 before commit;
        conditional GETs return 304.
  - [x] Integration: when the R2 object already exists, a second commit for an
        existing `storePathHash` returns `already-present` and leaves both the
        DB row and the R2 object byte-for-byte unchanged. The missing-object
        case is covered by the failure-recovery test below.
  - [x] Integration: a narinfo object missing for any reason (a failed write or
        eviction) is re-materialised from the row on the next negotiate; two
        concurrent commits for one `storePathHash` return exactly one
        `committed` and one `already-present`, leaving a single consistent row
        and object.

### narinfo cleanup on stale recovery

Serving narinfo from R2 means clearing a narinfo row alone is no longer enough:
the materialised object must go too, or a stale narinfo keeps being served from
R2 and the edge.

- [x] When negotiate takes the stale-recovery path (a committed narinfo whose
      NAR blob has vanished from R2), delete the `narinfo/<storePathHash>`
      object alongside the row and blob row, and best-effort purge the cached
      narinfo from the current colo. The purge is colo-local; other colos serve
      the stale narinfo until its TTL, and the subsequent re-upload
      re-materialises a byte-identical object. Durable cross-colo edge-safe
      deletion is a V3 concern.
- [x] Update the Routes table so narinfo and NAR show as Worker-served.
- [x] Tests:
  - [x] Integration: when a committed path's NAR blob is missing, the next
        negotiate clears the narinfo object and returns an upload decision, and
        a previously cached narinfo is purged from the current colo.

Deliberately deleting committed content — TTL-ordered NAR deletion, a durable
narinfo-deletion queue, and orphan reconcile — is deferred to V3 (see Garbage
collection and admin). V2 has no path that deletes a NAR a live narinfo points
at: abandoned-pending GC only removes never-committed blobs, and stale recovery
fires only once the NAR is already gone, so the edge-safe deletion machinery has
no trigger until reference-graph GC exists.

## V3

V3 collects improvements that are useful, but not necessary to prove the core
cache.

### Compatibility

- [x] Investigated `nix copy --to https://...` compatibility: Nix has no HTTP
      write protocol. `https://` binary caches are read-only for substitution,
      and `nix copy --to` writes only through `s3://`, `file://`, or
      `ssh(-ng)://`. Matching `nix copy --to` would mean fronting an
      S3-compatible write API (which overlaps the Later-features S3 tooling and
      re-implements presign/commit semantics Nix expects), so the native CLI
      upload flow stays the write path. Revisit only if Nix gains a first-class
      HTTP write protocol.
- [x] Decided: older Nix clients are out of scope (see Compatibility). cupboard
      is verified only against the current Nix it is tested with, with no
      guarantee for older releases; zstd substitution (Nix 2.4+) is a hard cliff
      regardless. Adding fallback NAR compression for old clients is a non-goal.

### Read path

- [x] Support private-read mode via HTTP basic auth, consumed by Nix through
      `~/.config/nix/netrc`.

  To enable: set both `CUPBOARD_READ_USER` and `CUPBOARD_READ_PASSWORD`
  (`wrangler secret put`). Reads then require Basic auth; `/pubkey`, `/_health`
  and `/_version` stay public. `cupboard config` with `--read-user` and
  `--read-password` (or those variables in the environment) prints the matching
  `netrc` line, keyed on the substituter host.

  Design:
  - A deployment-level private toggle plus a read credential
    (`CUPBOARD_READ_USER`/`CUPBOARD_READ_PASSWORD` secrets). When set, `read.ts`
    requires HTTP Basic auth on the narinfo, NAR, and `nix-cache-info` routes,
    compared in constant time.
  - `/pubkey` stays public: it is not secret, users need it to populate
    `trusted-public-keys`, and gating it complicates first-time config for no
    real gain.
  - Nix consumes it via netrc: clients add
    `machine <host> login <user> password <pass>` to a `netrc-file`. The
    `config` command emits the netrc snippet alongside the substituter line when
    a credential is configured.
  - Cached read responses key on the URL only, so in private mode `read.ts`
    skips `caches.default` entirely rather than putting authenticated bodies
    under a shared key. Keying cache entries by credential is deferred unless a
    later measured need justifies it.
  - Per-cache private mode is deferred; this is a global toggle first.

- [x] Support one or more named cache paths for organisation:
  - [x] `/cache/:cacheName/nix-cache-info`
  - [x] `/cache/:cacheName/<hash>.narinfo`
  - [x] `/cache/:cacheName/nar/<hash>.<ext>`
  - [x] `/cache/:cacheName/pubkey`

  Design:
  - Routing: named caches are served under a `/cache/:cacheName/...` prefix;
    `read.ts` matches the literal `cache` segment plus a cache name, and the
    bare root keeps serving the default (unnamed) cache, so existing deployments
    are unchanged.
  - Cache names are a single URL path segment, so they get their own
    `cacheNameSchema` rather than reusing `rootNameSchema` (root names allow `/`
    and other characters that do not belong in a path segment). Proposed
    pattern: `[a-z0-9][a-z0-9._-]{0,62}` — lowercase, no slashes, no
    percent-encoding.
  - Storage: add a `cache` column to `narInfos` and the retention tables,
    defaulting to the empty default cache. NAR blobs stay content-addressed by
    `narHash` and are **shared across caches** (identical bytes), so only
    narinfo membership and retention are per-cache; the narinfo R2 object is
    namespaced `narinfo/<cache>/<storePathHash>`.
  - Registry: a `cache` row (name, priority, created_at). Created implicitly on
    the first push or root with `--cache <name>` (default priority), or
    explicitly with `cupboard cache create <name> [--priority N]`. The default
    cache is the empty name with the standard priority.
  - Per-cache priority is honoured: `/cache/:cacheName/nix-cache-info` renders
    the cache's registered priority (the bare/default cache keeps the standard
    `CacheInfo.default` priority).
  - Management surface: `cupboard cache list` / `create [--priority]` /
    `inspect` / `remove [--force]`, backed by admin routes `GET /caches`,
    `PUT /caches/:cacheName` (upsert priority), and `DELETE /caches/:cacheName`
    (teardown — refuses the default cache and a non-empty cache without
    `--force`, which sweeps the cache's paths through the durable removal
    queue).
  - Reachability GC and retention roots are scoped per cache.
  - CLI: `--cache <name>` on `push`, `config`, `stats`, `root`, and `delete`.
  - One deployment-wide signing key, shared by all caches (each
    `/cache/:cacheName/pubkey` returns it). Per-cache keys would add rotation
    and config complexity with no clear personal-cache benefit.
  - The cron verifier (see Garbage collection and admin) background-reconciles
    every cache, named ones included; force-delete teardown and on-demand checks
    cover them too.

### Signing

- [x] Support rotation: generate a new keypair, keep old narinfos verifiable,
      and make the migration path explicit for users with pinned
      `trusted-public-keys`.
  - [x] Invalidate the Worker-side `/pubkey` cache when the key rotates.
        `/pubkey` is forwarded to the DO uncached and served `no-cache` with a
        strong ETag, so a rotation is visible immediately while Nix still
        revalidates conditionally.

  Design:
  - Generalise the single signing-key row to a `signing_key` set (id,
    `private_jwk_json`, `public_key`, `signing`, `published`, `created_at`).
    Outside a rotation, exactly one key is both signing and published. During a
    window both the outgoing and incoming keys are signing and published.
  - Old narinfos are never re-signed: they stay verifiable as long as clients
    keep the old key in `trusted-public-keys`. `/pubkey` returns every published
    key (newline-separated) during a window so clients can add the new key
    before the old is retired.
  - `cupboard key rotate` (admin) adds the new key as signing+published and
    prints the migration steps; `key retire <id>` later drops the old key from
    signing and then from publication once clients have updated.

- [x] Multi-signing during a rotation window is **mandatory**, not conditional.
      A client that still trusts only the old key must be able to verify a newly
      committed narinfo, so while both keys are published every new narinfo is
      signed by both the outgoing and incoming keys (the `sigs` array already
      supports this; verification accepts any trusted match). Migration order:
      rotate (new key joins signing + publication) → clients add the new key to
      `trusted-public-keys` → retire the old key from signing → then from
      publication. Outside a window, sign with the single active key only.

### Garbage collection and admin

Retention roots are the gating input for _automatic_ reachability GC: without
them, GC against committed narinfo rows would delete anything still reachable
through substitution, since the cache has no inherent concept of "in use". Roots
are modelled as named, moving channels (`github:owner/repo/main`, `.../pr-123`),
each holding a set of top-level store paths that a `push` replaces wholesale,
with an optional per-root TTL. The root name is an operator convention, so a PR
cache may choose a compact root such as `pr-123` or a repository-qualified name
as long as the policy binds it consistently. Reachability GC marks the
transitive closure from every live channel through `References`. This is built
in three increments:

- [x] Retention root model and admin API: a `retention_root` channel keyed by
      name with an optional `expires_at`, and a `retention_root_target` set of
      store paths. `cupboard root set/list/remove` (admin) create, replace, and
      drop channels. A set fully declares the channel (its targets and TTL,
      reset on each set), reports per-target presence, and is validated against
      shared name and TTL bounds. Inert until the sweep below consumes it.
- [x] Reachability GC: the daily pass expires channels past their TTL, marks the
      closure reachable from the live channels through `References`, and sweeps
      unreachable committed paths through the row-first delete and durable
      narinfo queue (so the NAR grace still applies). The sweep runs only when
      at least one committed path is reachable, so neither an empty channel set
      nor channels that point only at absent paths can collect the whole cache;
      root expiry happens regardless.
- [x] `push --root <name> [--ttl <dur>]` sets the named channel to exactly the
      pushed top-level paths (wholesale, after the uploads commit). A plain
      `push` instead records a durable implicit pin per top-level path, a root
      named `pin:<storePathHash>`, so manual pushes are never
      surprise-collected. `--ttl` governs whichever is created and defaults to
      permanent when absent, matching `root set`; the push output always reports
      the resulting expiry.
- [x] Delete a specific store path (explicit admin `delete`, edge-safe).
      Clearing old entries automatically is retention-based and stays below.
- [x] Optional retention period for cold paths. "Cold" = a path held only by an
      implicit `pin:<storePathHash>` root (a plain push), never named by an
      explicit root. `CUPBOARD_COLD_PATH_TTL_SECONDS` sets a deployment default
      TTL applied to newly created implicit pins, so casually pushed paths
      expire if not refreshed or explicitly rooted. Unset keeps the permanent
      default; explicit roots and pins carrying their own TTL are unaffected. A
      pure resolver decides the expiry and a thin env boundary reads the var, so
      the precedence (explicit TTL > matching policy > cold-path default >
      permanent) is unit-tested directly and the env wiring through an e2e.
- [x] Retention policies per cache or name prefix. A `retention_policy` set
      (scope `cache` or `root-name-prefix`, a pattern, a default TTL). When a
      root is created without an explicit TTL, the most specific matching policy
      supplies one (e.g. `pr-` → 14 days): a prefix match beats a cache match,
      and a longer prefix wins. `cupboard policy list/add/remove` and the
      `/policies` routes manage them. Both scopes are live now that named caches
      have landed.
- [x] Repair/check command to compare metadata against R2. The admin
      `GET /check` route and `cupboard check [--deep]` scan the committed
      narinfo rows (bounded, the report flagging an incomplete scan), confirm
      each narinfo's R2 object and the NAR it depends on, and with `--deep`
      re-run the upload-time checksum verification against the stored bytes. NAR
      blobs are shared, so each is checked once but a fault is attributed to
      every narinfo depending on it. Check-only: it never mutates state. The
      repair actions it pointed at are delivered by the background verification
      below.
- [x] Cron-driven background verification. `POST /verify` is the scheduled
      counterpart to the check: a bounded pass that re-materialises a missing
      narinfo object and reconciles a narinfo whose NAR has vanished (row-first
      removal + the durable queue and grace, gated by the global
      unreferenced-NAR check). It keeps its own route, separate from `/gc`, so
      each can run and be asserted independently, and the cron tick runs both
      every pass regardless of the other's outcome. Progress is a single-row
      `verification_cursor` holding a composite `(cache, store_path_hash)`
      position, advanced one fixed batch per run and wrapped at the end;
      `?limit` bounds a manual run. The pass spans every cache, walking the
      `(cache, store_path_hash)` space in order, so named-cache objects are
      reconciled in the background alongside the default cache. Cloudflare
      Queues remain a fallback only if a scan cannot stay within cron/DO limits.
- Edge-safe deletion mechanism for committed content. narinfo is edge-cached
  with a max-age, and `caches.default.delete` only purges the current colo, so a
  deleted narinfo can be served from a warm edge until its TTL expires. Deleting
  committed content must not leave a cached narinfo pointing at a deleted NAR:
  - [x] One narinfo cache TTL constant; derive the GC grace from it
        (`grace = ttl + margin`) so the `Cache-Control` max-age and the grace
        cannot drift apart.
  - [x] On narinfo removal, delete the narinfo row in the transaction that
        enqueues its object cleanup, then best-effort delete the
        `narinfo/<storePathHash>` R2 object and `caches.default.delete` in the
        current colo. Enqueue the NAR for deletion no earlier than
        `now + grace`, only if no other narinfo references that NAR hash, and
        only once the narinfo object has actually been removed, so the grace
        clock starts from object removal. Removal is **row-first**: the narinfo
        row is the source of truth, so a leftover R2 object can never bring the
        path back to life.
  - [x] Extend `orphan_blob_deletion` with a `not_before` timestamp (Drizzle
        migration). The flush deletes a blob only when `now >= not_before` and
        the committed and live-pending checks still pass; abandoned pending
        uploads keep `not_before = now`. `not_before` is monotonic
        non-decreasing — an enqueue conflicting on the `r2_key` primary key
        takes `max(existing, new)`, never earlier, so a delayed blob is never
        pulled forward by a later immediate enqueue.
  - [x] Durable narinfo-deletion queue (`narinfo_deletion`, keyed by store path
        hash): the removal transaction deletes the narinfo row and enqueues the
        object cleanup. An opportunistic flush deletes the R2 object and, only
        on success, schedules the now-unreferenced NAR (re-checking references
        at that point). GC flushes the queue idempotently, finishing any
        interrupted removal without the re-run requirement. A re-committed row
        drops its stale queue entry instead of deleting the now-live object.

### Hardening

Coverage deferred from V1 once the core cache was proven; tracked here so it is
not lost.

- [x] Concurrent-write coverage: racing commits and negotiations on the same
      store path hash and NAR hash resolve to one committed row and consistent
      blob accounting (deferred from V1 Storage).
      `concurrent-write.workers.test.ts` covers a two-way commit race, four
      concurrent pushes of one path settling to a single row, and two distinct
      paths sharing one NAR.
- [x] Durable Object durability coverage: DO SQLite state — the signing key set
      and committed metadata — persists in its final shape and stays consistent
      across a fresh stub for the same DO name (deferred from V1 Storage and
      Signing). `durability.workers.test.ts` reads the persisted rows from
      `state.storage` and re-derives `/pubkey`, a working token, and a verifying
      narinfo. The harness exposes no forced-eviction API, so durability is
      asserted through storage and a fresh stub rather than a real restart.

## V4

V4 replaces the V1 opaque bearer-token model with short-lived, cupboard-issued
JWT access tokens, and federates both CI and the owner without any long-lived
secret. Authentication runs through a conventional OAuth 2.0 token-exchange
endpoint built with `jose`: CI proves where a job ran, and the owner logs in
interactively, each presenting an external OIDC token that cupboard exchanges
for a short-lived cupboard JWT. Upload and admin handlers stay on one validation
path: `Authorization: Bearer <cupboard-jwt>`.

### The token endpoint

A single endpoint serves both callers, differing only by which trust rule the
subject token matches. Verification is uniform; `jose` does the cryptography.

- [x] `POST /token` — one RFC 8693 token-exchange grant. The `subject_token` is
      an external OIDC token (the owner's `id_token` or a CI GitHub Actions
      token); cupboard verifies it against the matching rule's issuer and mints
      a cupboard access JWT — owner login yields `admin`, CI yields `write`.
      Success and error bodies follow RFC 6749 §5.1/§5.2;
      `Cache-Control:     no-store`.
- [x] Sign cupboard access JWTs with a deployment-owned key (`auth_key`) in the
      RFC 9068 shape: `typ: at+jwt`, a `scope` claim, and the signing key's
      `kid` in the header. Write tokens carry a `cb_roots` claim; admin tokens
      are unconstrained. Tokens are short-lived and stateless — no issued-token
      table; expiry and key rotation cover revocation.
- [x] Verify inbound tokens with issuer and audience pinned and an asymmetric
      algorithm allowlist (RS256/PS256/ES256/EdDSA), never the token's own
      header and never `alg: none` or a symmetric algorithm. Verification has
      its own path, so an inbound OIDC token is rejected on resource routes.
- [x] Discover each issuer's `jwks_uri` and accepted signing algorithms from its
      OIDC metadata (`<issuer>/.well-known/openid-configuration`), cached with a
      cooldown. A trust rule stores only the issuer, so `jwks_uri` is never
      hand-typed; the discovered `id_token_signing_alg_values_supported`,
      intersected with cupboard's asymmetric allowlist, narrows the accepted
      algorithms per issuer (RS256 fallback when the issuer omits the field).
- [x] Bound the SSRF surface of the issuer and `jwks_uri` fetches. Both are
      restricted to https (loopback excepted for local development) with no
      query or fragment, and neither the discovery fetch nor jose's JWKS fetch
      follows redirects, so a hijacked metadata endpoint cannot pivot to another
      host. Reaching private, loopback or link-local (cloud-metadata) addresses
      is prevented by the Workers runtime: `globalOutbound` permits only
      publicly-routable addresses and filters them after DNS resolution, so the
      connect-time IP checks that self-hosted verifiers hand-roll are neither
      expressible through `fetch()` nor needed here. A self-hosted workerd must
      keep the default `allow = ["public"]` for this to hold.
- [x] `GET /.well-known/jwks.json` publishes the auth public keys, DO-served and
      Worker-proxied like `/pubkey`;
      `GET /.well-known/oauth-authorization-server` is RFC 8414 metadata built
      at the edge from the deployment origin.

### Trust rules and the owner

- [x] `oidc_trust` rules federate an external identity into a scope: filter by
      issuer, exact-match every configured claim, most-specific match wins.
      Prefer stable ID claims (GitHub `repository_id`, `repository_owner_id`).
      Providers are data, not hardcoded branches — the same evaluator fits
      Google, Entra, Auth0, Okta, and GitHub Actions.
- [x] The owner is an `admin` rule seeded on DO init from deploy config
      (`CUPBOARD_OWNER_*`), pinned on issuer, subject, and audience. Break-glass
      is a redeploy with updated config. CI rules are `write`-scoped, added
      through the admin API, and bind the minted token to `allowed_roots` via
      `cb_roots`, enforced at `PUT /roots/<name>` so a CI token for one
      repository cannot replace another's root. A `cb_roots` entry matches a
      root by exact name, or — when it ends with `/` — any root beneath that
      prefix. The claim scopes retention roots only; NAR uploads stay
      deployment-wide, shared within the owner's single trust domain (see
      Tenancy).
- [x] Admin `oidc-trust` CRUD: list (with a `disabled` flag, no `jwks` detail),
      add a write rule, and soft-disable. The owner rule is not editable through
      the API.

### Owner interactive login

- [x] `cupboard login` obtains an owner `id_token` from the configured generic
      OIDC provider (a registered public client; PKCE, no client secret) and
      exchanges it at `/token` for an admin JWT. The default flow is PKCE with a
      127.0.0.1 loopback redirect; `--headless` falls back to the RFC 8628
      device flow. The owner rule pins `aud` to the client id, blocking
      cross-app `id_token` replay.
- [x] Cache the admin session at `~/.config/cupboard/tokens/` (mode 0600) and
      reuse it across invocations. `init` and the admin commands take the cached
      token through the existing `TokenProvider` contract. The tenant token
      endpoint implements the RFC 6749 `refresh_token` grant (rotating,
      single-use, a thirty-day window renewed on use; admin sessions only), and
      an expired or refused access token renews silently: first by rotating the
      cupboard refresh token, then by exchanging a fresh `id_token` from the
      deploy's stored Cloudflare grant. Only when neither silent path can mint
      does a command prompt for `cupboard login`.

### CI federation

- [x] `cupboard push --github-oidc [--audience <aud>]` requests a GitHub Actions
      OIDC token (`id-token: write`) for cupboard's audience and exchanges it
      for a root-scoped write JWT, with no stored cupboard secret. `--audience`
      defaults to the Worker URL.

### Key rotation and maintenance

- [x] Auth-key rotation as a key set: the newest non-retired key mints, every
      non-retired key verifies, and the JWKS publishes each.
      `POST     /keys/auth/rotate` adds a key; `POST /keys/auth/retire/<kid>`
      retires one and refuses the last.
- [x] The cron drives garbage collection and verification through direct Durable
      Object RPC (`runGarbageCollection`/`runVerification`), authorised by the
      service binding, so no secret is exchanged on the maintenance path.

### Removing the bootstrap secret

- [x] Once the cron (RPC) and the CLI (login / `--github-oidc`) no longer use
      it, delete `/auth/bootstrap`, `CUPBOARD_BOOTSTRAP_TOKEN`, and the
      bootstrap response schema. Break-glass becomes a redeploy with fresh owner
      config.
- [x] Remove the legacy `token` table and V1 opaque-token init flow.

### Tests

- [x] Unit: cupboard-JWT verification rejects a wrong issuer, audience,
      algorithm, expiry, not-before, missing scope, unknown `kid`, missing
      `typ`, and a malformed `cb_roots` claim; inbound OIDC verification against
      a local JWKS covers RS256/ES256/EdDSA and rejects a symmetric algorithm.
- [x] Unit: trust-rule matching accepts only the configured issuer, audience and
      claim set, with GitHub Actions and an owner rule as fixtures.
- [x] Integration: `/token` returns the right OAuth error for an unsupported
      grant, a non-JWT subject token, and a subject token matching no rule; the
      owner rule is seeded on init; JWKS and AS metadata have the expected
      shape.
- [x] Integration: a write token may set only its permitted roots; auth-key
      rotation keeps old tokens verifying until the key is retired; the cron RPC
      runs GC and verify with no secret.
- [x] E2E: owner login against a stubbed OIDC issuer yields an admin JWT and a
      non-owner subject is refused; a CI-style GitHub Actions token is exchanged
      for a write JWT and performs the normal push, while a mismatched
      issuer/audience/claim is rejected; `CUPBOARD_BOOTSTRAP_TOKEN` exists
      nowhere.

## Correctness and hygiene pass

This pass tightens the protocol and boundary model before extending auth
further. The goal is one validation model on every boundary: JSON parsing is
only the lexical step, Zod schemas own the wire shape and semantics, and a tiny
pure lexer handles text formats such as narinfo before a schema validates them.

- [x] Add Zod v4 to `@cupboard/shared`.
- [x] Split the monolithic shared protocol module into focused modules, with
      `index.ts` remaining re-exports only:
  - [x] `scalars.ts` for reusable branded field schemas.
  - [x] `hash.ts` for Nix SHA-256 parsing, base32/base64 conversion, and digest
        length checks.
  - [x] `store-path.ts` for store path parsing, hashing, basenames, and
        reference basename conversion.
  - [x] `messages.ts` for strict request and response schemas. Unknown JSON keys
        are rejected; upload decisions use a discriminated union; transformed
        schemas provide their output types.
  - [x] `narinfo.ts` for a pure field lexer, narinfo schema, rendering,
        fingerprinting, and multi-signature support.
  - [x] `cache-info.ts` and `nix-config.ts` for the remaining text renderers.
  - [x] `errors.ts` for the small set of typed protocol errors still thrown by
        free functions.
- [x] Retire the hand-written wire interfaces, validator classes, and duplicate
      `fromFields` model layer once the schemas own those contracts.
- [x] After schema parsing has replaced the DTO layer, revisit message output
      types. Prefer branded parsed or domain types at trusted boundaries, while
      keeping buildable wire input types unbranded unless construction can be
      made brand-safe without casts.
- [x] Validate every JSON boundary:
  - [x] server request bodies return typed 400s on malformed or structurally
        invalid JSON;
  - [x] CLI server responses are schema-checked before use;
  - [x] scheduled-GC bootstrap responses are schema-checked;
  - [x] server reads of DB-stored JSON fail as typed server errors when corrupt.
- [x] Support multiple narinfo `Sig:` lines. Rendering emits one line per
      signature; verification accepts any trusted matching signature.

### Correctness fixes

- [x] Reject narinfo integers with trailing junk (`123abc`, `1e9`, empty
      string).
- [x] Trim CRLF line endings in the narinfo lexer.
- [x] Parse `References` with whitespace splitting that drops empty elements.
- [x] Build narinfo fingerprints from sorted full reference store paths, not a
      caller-side ordering invariant.
- [x] Make the Nix base32 decoder reject out-of-alphabet characters explicitly.
- [x] Give `If-None-Match` precedence over `If-Modified-Since`.
- [x] Support `If-None-Match: *`, comma-separated ETags, and weak ETags.
- [x] Remove the dead `resolveBearer` refresh branch from the CLI client.
- [x] Guard reusable-blob row cleanup with a committed-reference check when R2
      reports the blob missing.
- [x] Purge swept narinfos from the edge cache on interactive GC via the
      caller's public origin; the cron sweep arrives on the internal origin and
      cannot know the public URL, so it relies on the narinfo TTL and the
      orphan-blob grace window instead.
- [x] Build NAR file entries from one opened file handle so size, contents, and
      padding cannot diverge if a file changes mid-read.
- [x] Keep `HEAD` as a direct R2 metadata check rather than consulting the edge
      cache; the Cache API is GET-oriented, so reusing a cached GET for HEAD
      would risk header divergence for no meaningful saving.
- [x] Fix zstd write-side backpressure so completion waits for the write
      callback and for the transform to drain.
- [x] Delete expired-root target rows and the root row in one transaction.

### Correctness Tests

- [x] Parameterised schema tests cover missing keys, wrong types, bad hashes,
      store path hash mismatches, empty root targets, TTL bounds, unknown keys,
      malformed narinfo lines, multi-signature narinfo round-trips, and integer
      coercion guards.
- [x] HTTP conditional-request tests cover ETag precedence, wildcard ETags,
      comma-separated ETags, and weak ETags.
- [x] Worker integration tests cover malformed request bodies returning 400,
      corrupt stored metadata returning 500, reusable-blob cleanup protection,
      and GC purging swept narinfo objects from the current colo.
- [x] CLI tests cover schema validation of server responses.
- [x] The e2e substitute flow still passes with the new narinfo renderer and
      multi-signature verification path.

## V5

Status: implemented and live on `hono-orpc-refactor`. The sections below are the
design record for the multi-tenant system that now runs; see "Current state"
near the top of this document for how it maps onto the code.

V5 turns cupboard into a hosted, multi-tenant service. One operator runs the
instance and onboards independent, mutually-distrusting tenants. Each tenant has
its own owner, signing keys, OIDC trust rules, retention roots, narinfo
metadata, and storage accounting. NAR bytes sit underneath that in a shared,
content-verified CAS.

This is a **clean-slate** multi-tenant system, not a migration of the existing
single-tenant cache. There is no legacy path and no compatibility carve-out: V5
serves only blobs that entered through the new server-side verification path and
reached `available`. An existing single-tenant deployment stays on the V4 line,
or the operator re-pushes content into V5.

Settled decisions:

- No privileged "primary" tenant. Every cache lives under `/t/<tenant>/`; the
  bare host is the control surface.
- Bootstrap is by first signup, but through a gated claim. The first
  authenticated principal is promoted to global admin only when they satisfy the
  configured claim gate.
- The Worker is a first-class Hono coordinator. There is no singleton
  control-plane Durable Object; global state lives in D1 with a KV read-cache
  for admission.
- The shared CAS is content-verified. Cross-tenant references live in D1, but
  tenant trust identity lives in per-tenant narinfo signatures.
- V5 is strict verify-before-serve. No narinfo is servable until the shared blob
  is verified and `blob_state` exists.

### Invariants

- **Servability coherence, in two layers.** The serve-time gate is exactly what
  the read path checks: the materialised tenant narinfo R2 object exists (plus
  admission and `readMode` auth at the edge). Reads run Worker to R2 and the
  Cache API and never consult D1 or the DO, so this gate is eventually
  consistent with control state, bounded by the narinfo TTL and edge cache. The
  commit-time/maintenance invariant is that a narinfo R2 object is materialised
  only after the registry row is active, the per-narinfo edge exists,
  `blob_state` is `available`, and the shared R2 object exists — and is
  de-materialised (object deleted, cache purged) by the owning DO when any of
  those ceases. No legacy or unverified carve-out.
- **Per-narinfo identity and replay safety.** There is no atomic transaction
  across DO SQLite, D1, and R2. Every cross-store mutation is keyed by
  per-narinfo identity `(tenant, cache, storePathHash, generation)`, never by an
  aggregate counter, with `generation` from a durable per-store-path counter
  that survives deletion. Replayed increments and decrements are idempotent by
  primary key, commit and delete are both ordered row-first/edge-last to fail
  safe, and a named, bounded, DO-owned repair pass drives every half-finished
  saga from its durable marker to a terminal state, idempotently under the
  captured per-version identity. There is no leaked-edge-forever direction.
- **Control-plane separation.** The control plane is its own OAuth issuer with
  its own signing-key lifecycle, separate from every tenant issuer.

### Tenancy model

A tenant is addressed by a slug in the URL path:
`https://<host>/t/<tenant>/...`. The slug is a new shared scalar
(`tenantIdSchema`, using the `cacheNameSchema` shape). Tenancy is the outer
boundary and named caches nest within it:
`/t/<tenant>/cache/<name>/<hash>.narinfo`.

The bare host serves only the control surface: health/version, control-plane
auth, admin/signup routes, and the global-admin bootstrap. It serves no cache
content. Each tenant is one `CupboardServer` DO addressed by
`idFromName(<tenant>)`. Per-tenant signing and auth keys live in that DO's
SQLite database. A tenant's DO is the single writer for that tenant's
`blob_ref`/`tenant_blob` rows, serialising its accounting transitions (including
offboarding, which deletes those rows through the DO, not from the Worker). This
is per-table, not blanket: `blob_state` is shared and multi-writer (any tenant
DO at promote, the queue consumer promoting the bytes it has just verified, the
Worker reaper for `delete_after` and collection); the tenant DO writes its own
`tenant_usage` counters (`bytes`/`narinfos`/`blobs`, where it charges and
credits quota) while the Worker writes only that row's quota configuration
(`quota_bytes`) — disjoint columns, no write conflict; and the Worker owns
`tenant`, `control_*`, and `global_admin`.

### Control plane

The Worker owns tenant resolution and admission, read serving, dispatch to
tenant DOs, the control-plane auth and admin surface, cron fan-out, and the
global blob reaper.

Global state lives in a new D1 database (`CUPBOARD_DB`). D1 is transactional,
enumerable, readable by the Worker and DOs, and not on the public read hot path.
It holds the tenant registry, per-narinfo reference edges, the available blob
set, the control-plane signing-key set (public metadata and the envelope-wrapped
private JWK, whose wrapping secret is bound only on the control-plane Worker),
the global-admin record, and per-tenant usage/quota.

Admission resolves `/t/<slug>/` against a cached, versioned manifest in KV
(`TENANT_CACHE`), revalidated against a tiny `tenant-manifest:version` key at
most once per short interval. A slug absent from the manifest is rejected before
any DO is instantiated; otherwise varying the slug could create unbounded,
unprovisioned DOs. Each manifest record carries
`{ status, readMode, configVersion }` and, for private tenants, a per-tenant
read verifier (a hashed credential, never a DO signing key — plaintext secrets
stay out of KV). The manifest is therefore the single read-path authority for
tenancy state: `handleRead` enforces `readMode` from the already-loaded entry
with no D1 or DO read on the GET path. Unauthenticated control routes return 404
to avoid a control surface tenant-existence oracle. Public cache reads can still
reveal a slug once content is known, which is acceptable.

Manifest publication is an ordered D1-then-KV saga (no shared transaction):
provisioning writes the authoritative D1 `tenant` row first, then the full
manifest body under a version-suffixed immutable key (`manifest:<version>`),
then bumps `tenant-manifest:version` last as the commit point. Reading version N
fetches either the complete body for N or a KV miss, never a stale body
mislabelled N; a colo falls back to last-known-good. KV cross-colo propagation
bounds provisioning visibility.

Suspension and offboarding semantics are: immediate write stop, eventual read
stop. The Worker performs an authoritative D1 `tenant.status` read before
dispatching any write or admin RPC (writes are not the hot path, so the read is
affordable); the KV manifest governs only read routing. "Immediate" means no new
write/admin request is admitted once suspension is durable in D1; a request
already in flight to a warm DO may still complete (a bounded TOCTOU). Reads stop
after the KV manifest TTL. Immediate read-stop means invalidating or
short-TTLing the manifest entry at a hot-path consistency cost, which the
default declines.

### Control-plane authentication

The bare-host control surface has its own auth. Per-tenant `auth_key` rows live
in tenant DO SQLite and cannot sign global-admin tokens. The Worker is
stateless, so control-plane key material is persisted outside it — but its
**private** part must be reachable only by the Worker, never by a tenant DO:

- `control_auth_key` is the rotatable control key set. Its public key metadata
  (`id`, `kid`, `public_jwk`, `created_at`, `retired_at`) and the
  envelope-wrapped private JWK both live in `CUPBOARD_DB`, so the stateless
  Worker can publish the control JWKS and mint and rotate control tokens. The
  private JWK is wrapped with AES-256-GCM under `CONTROL_KEY_WRAP_SECRET`, and
  that secret is the real boundary: it is bound only on the control-plane
  Worker.

  Binding a secret "only on the Worker" is meaningful only because the tenant
  Durable Object runs in a **separate Worker script**. Within one script every
  binding (a Workers secret included) is shared between the default handler and
  the Durable Object classes that script defines, and a `D1Database` binding is
  database-wide, so a single-script deployment could not withhold the wrapping
  secret from the DO and the envelope wrapping would protect nothing against it.
  The `CupboardServer` Durable Object therefore lives in its own
  `cupboard-tenant` Worker script, which binds `CUPBOARD_DB` and the R2 bucket
  but never `CONTROL_KEY_WRAP_SECRET`; the control-plane Worker reaches every
  tenant through an external Durable Object binding
  (`script_name = "cupboard-tenant"`). A tenant DO can read the wrapped key from
  D1 but has no binding to the secret that unwraps it, so it cannot recover the
  control signing key. This split is established in step 3, not deferred.

- The control issuer is the bare host origin; the control audience is the
  control client id. Bare `/.well-known/jwks.json` publishes the control public
  keys. `/t/<tenant>/.well-known/jwks.json` publishes that tenant's keys.
- Rotation is an admin operation that inserts a new `control_auth_key`; retiring
  the last key is refused.

Login mirrors the tenant model: claim-based federation, not a hardcoded
provider. Bare-host `POST /token` is an RFC 8693 token exchange. The caller
presents an external OIDC subject token; the Worker verifies it against the
control trust policy, checking `iss`, `aud`, `sub`, and an optional exact-match
claim map, exactly like a tenant `oidc_trust` rule. It then mints a
control-plane admin access token signed with the current `control_auth_key`.

The CLI obtains the external token through the existing interactive flows: PKCE
loopback by default, and `--headless` device flow when needed. Control-plane
tokens authorise control operations such as tenant CRUD, suspension, and
offboarding. Tenant tokens authorise tenant operations.

### Bootstrap

A fresh deployment has no global admin and no control trust policy. The
deployment is configured with the OIDC provider to trust for control-plane
login: issuer and public client id. The first principal to authenticate and call
the claim endpoint is promoted to global admin by a first-writer-wins insert
into D1 (`global_admin` singleton, unique constraint). The claim also seeds the
control trust policy, pinning that principal's `iss`, `sub`, and `aud`, after
which `/token` works as above. The Worker verifies the deploy-configured gate
(the single-use claim secret or the pinned `(issuer, subject)`) first; then the
`global_admin` insert, the `control_trust` seed, and recording claim consumption
are one atomic D1 batch. Single-use is enforced by a D1 record, not by mutating
an env secret (an env secret cannot be "consumed"): the first-writer-wins
`global_admin` row is the consumption marker. A second claim by a **different**
principal is **refused** (the row already exists); a re-claim by the **same**
principal is idempotent and returns the existing claim state. The atomicity
matters because otherwise a crash between the writes leaves `global_admin`
claimed but `control_trust` empty (no rule matches, so `/token` can never mint
an admin token) — a permanently un-administerable deployment. This is the only
irreversible bootstrap transition.

The claim gate is required in hosted mode. The claimant must satisfy either a
single-use claim secret or a pinned `(issuer, subject)`. With neither
configured, claims are refused. An explicit local-dev flag relaxes this only for
local development.

### Shared CAS

The shared CAS has two layers:

- **Shared verified blob layer.** NAR blobs live at `nar/<narHash>.nar.zst`,
  shared across tenants. A blob is promoted into this namespace only after
  cupboard verifies that its bytes decompress to its key. The shared namespace
  therefore contains only confirmed content.
- **Per-tenant narinfo layer.** `(cache, storePathHash) -> narHash + signature`
  lives in the tenant DO SQLite database. The materialised R2 object is
  tenant-namespaced at `t/<tenant>/narinfo/[<cache>/]<storePathHash>`. The
  signature uses the tenant's own key, so a substituter trusts a tenant only via
  that tenant's key.

Cross-tenant dedupe is safe because tenant B never resolves tenant A's narinfos
and never trusts tenant A's signing key. A write token for A can write only A's
narinfos and namespace; it can only reference shared bytes after those bytes are
verified by the server.

### References, accounting, and GC

References are rows, not aggregate counters:

- `blob_ref(...)` is one row per narinfo version:

  ```text
  blob_ref(
    tenant,
    cache,
    store_path_hash,
    generation,
    nar_hash,
    PK(tenant, cache, store_path_hash, generation)
  )
  ```

  The edge identifies the exact narinfo version that created it, never "the
  current edge for this store path". Commit uses `INSERT OR IGNORE`; deletion
  targets the captured generation only, so stale deletion replay cannot remove a
  newer recommitted edge, even if it has the same `nar_hash`. `blob_ref` carries
  a **secondary index on `nar_hash`** (mandatory): the reaper's reference probe
  is on `nar_hash`, a non-key column, so without it the probe is a full-fleet
  table scan that stalls the reaper and leaks blobs at scale.

- `generation` has a **durable, strictly-increasing source per
  `(cache, store_path_hash)` that survives deletion** — a
  `generation_seq(cache, store_path_hash, next_generation)` row in DO SQLite,
  advanced at commit and never reset by delete or offboarding. Sourcing it from
  the narinfo row (which delete removes) or `max(blob_ref.generation)` (which
  delete drains) resets to 1 and lets a stale deletion match a
  freshly-recommitted same-`nar_hash` edge, silently reaping a servable
  narinfo's blob — and reproducible builds make same-`nar_hash` recommit the
  norm. Lifetime-monotonicity is what makes both compare-and-delete and
  `INSERT OR IGNORE` idempotency hold.

- `tenant_blob(tenant, nar_hash, file_size, PK(tenant, nar_hash))` is the
  derived fact that a tenant references a blob via at least one live narinfo
  version. The tenant DO maintains the 0-to-1 and 1-to-0 transitions.
- `blob_state(...)` is the set of available shared blobs:

  ```text
  blob_state(
    nar_hash PK,
    file_hash,
    file_size,
    compression,
    nar_size,
    verified_at,
    delete_after?
  )
  ```

  It records positive shared facts only and carries the canonical compressed
  metadata of the single shared object.

A servable narinfo takes `FileHash`, `FileSize`, and `Compression` from
`blob_state`, not from the tenant's own staging upload. Tenants may upload
different zstd encodings of the same NAR, but the shared CAS stores one
canonical compressed encoding per `narHash`. The signed fingerprint uses the
uncompressed `NarHash` and `NarSize`, so it is independent of the compressed
encoding.

Verification failures stay on the per-tenant staging upload, never in global
`blob_state`: a bad upload claiming `narHash = X` proves that upload is bad and
must not poison hash `X` globally. Every fresh upload defers to the background
verification pass; the commit WebSocket parks until that pass delivers the
verdict. A failure records a durable `mismatch` or `over-quota` verdict on the
upload, so a waiter that reconnects later can still observe why a deferred path
never became servable.

Counts and usage are derived from edges:

- narinfos: `COUNT(blob_ref)` for a tenant;
- unique blobs: `COUNT(tenant_blob)` for a tenant;
- bytes: `SUM(tenant_blob.file_size)`.

Quota (which lands in step 6; step 2 builds the edge/presence machinery without
the charge) is charged once per tenant per unique `nar_hash` on the tenant's own
verified staged `file_size`, so `SUM(tenant_blob.file_size)` equals
`tenant_usage` exactly. Two tenants may be charged different sizes for the same
hash when their encodings differ — a benign dedup-at-rest property; each pays
for the bytes it transmitted. A user comparing quota with Nix's uncompressed NAR
size will see a difference (the charge is the compressed `file_size`, not
`nar_size`).

The charge is idempotent because it is gated on the `tenant_blob` 0-to-1
`INSERT OR IGNORE` actually inserting (`changes()`-derived), not on a standalone
increment update, so a replayed reservation cannot double-charge. The
reservation, the `blob_ref`/`tenant_blob` edges, and the charge are one atomic
D1 batch: an over-quota reservation makes the whole batch reject, so no edge and
no charge are ever stranded. Credit is symmetric on the 1-to-0 transition,
driven by the DO. `tenant_usage` is the authoritative quota counter; cron
roll-up is reconciliation and audit.

The "single writer per tenant's D1 rows" rule is per-table. `blob_ref` and
`tenant_blob`: the owning tenant DO only. `blob_state`: multi-writer — any
tenant DO inserts/clears it at promote, and the Worker reaper arms
`delete_after` and collects; the DO-versus-reaper conflict is resolved at the
D1-row level (the `delete_after IS NOT NULL` guard makes promote/reuse clears
and reaper deletes mutually exclusive). `tenant_usage` is split by column: the
tenant DO writes the usage counters (`bytes`/`narinfos`/`blobs`), the Worker
writes only `quota_bytes` (admin config) — disjoint, so no conflict. Offboarding
deletes a tenant's edge rows through that tenant's DO, never directly from the
Worker.

Per-tenant reachability GC stays in each DO. Sweeping a narinfo deletes the
matching `blob_ref` row and, on the tenant's last live reference to a `narHash`,
its `tenant_blob` row and quota charge. The global reaper (Worker cron) is the
only actor that sees all tenants' edges, so it alone arms and acts on
`delete_after`, in two bounded passes over `blob_state`. Both are self-draining
(arming sets `delete_after`, collecting deletes the row), so they need no stored
position; only the separate demote pass below, a pure read scan that does not
consume its rows, keeps a resume position (a single KV value, see below):

1. **Arm**: set `delete_after = now + grace` where
   `delete_after IS NULL AND NOT EXISTS(blob_ref ... nar_hash)` (the indexed
   probe). Nothing else sets `delete_after`; as previously written (no setter,
   `now >= NULL` falsy) the reaper could never fire and every blob leaked.
2. **Collect** (after grace): for each candidate, one conditional D1 delete
   re-checking
   `NOT EXISTS(blob_ref ...) AND delete_after IS NOT NULL AND now >= delete_after`;
   then delete the R2 object after the D1 `blob_state` delete commits (D1-first,
   R2-last), so crash residue is a harmless orphan object the next promote
   adopts, never an "available but no object" stranding.

`delete_after` is cleared to NULL by the paths that re-reference a hash: promote
(`ON CONFLICT DO UPDATE SET delete_after = NULL`), a negotiate that plans a
reuse of an armed hash (the tenant DO clears it before answering), and
reuse-commit (an explicit update in the same batch as its edge insert — a
synchronous reuse commit does no promote, so this is mandatory; a deferred reuse
settles through a decode-free promote against the canonical object, which clears
it the promote way). The grace is the single deployment-wide
`narinfo TTL + margin` (one TTL constant, preserved from V3). The reaper also
runs a demote pass — it, not the per-DO verify pass, is the only actor that can
scan global `blob_state` — keyset-paginating `blob_state` by `nar_hash` from a
resume position held in a single KV value (cron bookkeeping, not shared-blob
data, so it stays out of the relational schema), heading the canonical object,
and on confirmed absence (same in-transaction re-check) deleting the
`blob_state` row. `findReusableBlob`'s reference check queries `blob_ref` across
tenants, not the local DO's `narInfos`.

### Cross-store ordering

Every commit and delete is a saga ordered so a crash leaves a convergent state a
bounded repair pass drives to completion — never a servable narinfo without its
blob, and never a permanently leaked blob or quota charge.

Commit is row-first and edge-last. (The earlier edge-first sketch was unsafe: an
edge written before the row is, to the reaper, a live reference, so a crash
before the row pinned the blob and its quota charge forever with nothing to
sweep it.) Servability is the materialised R2 narinfo object — there is **no
`servable` flag, in any step**. "Not yet servable" is encoded by the narinfo row
existing without its R2 object, and in-flight/failed status lives in
`pending_upload.verdict`; a stored flag is never needed. (Recorded deviation
from the original "track servability per narinfo".) The ordering below is
uniform across step 2 and step 6 — step 6 only adds the quota check and charge
at the points marked, never a flag or a pre-verify reservation:

1. The client uploads the compressed blob to a per-tenant staging key; R2
   verifies the compressed `fileHash` checksum.
2. (Step 6, first: a cheap **read-only pre-verify quota check** runs **before
   any write** — if the tenant is clearly over quota the commit is rejected here
   having written nothing, no row and no `generation_seq` advance, and the
   staging object is reclaimed; it is advisory, not the authority.) The DO then
   advances `generation_seq` and writes the narinfo row at that generation, not
   yet servable (no R2 object materialised).
3. The server verifies the staging object, inline for small blobs and in the
   background for large blobs.
4. On a hash match, the server ensures the shared R2 object exists, promotes the
   staging object if needed, and upserts the `blob_state` row (clearing any
   `delete_after`).
5. The DO reserves in one atomic D1 batch: `blob_ref` (`INSERT OR IGNORE`),
   `tenant_blob` upsert, and (step 6) the **authoritative** conditional quota
   charge gated on the `tenant_blob` 0-to-1 insert (idempotent). An over-quota
   batch rejects; the narinfo row is reclaimed (it has no R2 object yet) and the
   staging is reclaimed.
6. Only then does it materialise the tenant narinfo object (servable).

A crash before step 6 leaves a not-servable narinfo row (and, before step 5, no
D1 footprint at all) that the per-DO sweep reclaims; the reaper never sees an
edge without a row. A recommit is an explicit read-then-transition: read the
live narinfo; an identical-content re-push is idempotent and does not bump
`generation_seq`; differing content advances `generation_seq`, updates +
re-signs + re-materialises the narinfo in one DO critical section, reserves the
new-generation edge, then retires the old-generation edge through the deletion
machinery — so a stale deletion of the old generation can only remove the old
edge. (Today's `handleCommit` short-circuits an existing row to
`already-present`; recommit replaces that with this content-keyed transition.)

Delete is row-first and edge-last. The durable saga marker is the
`narinfo_deletion` row itself, keyed by `(tenant, cache, storePathHash)` and
carrying the captured `nar_hash` and generation: its existence records that a
delete is in flight, and its removal is the single terminal step — there are no
timestamp phase columns. Delete deletes the narinfo row and queues the marker in
one DO transaction (instantly non-servable), then removes the R2 narinfo object,
deletes the captured-generation `blob_ref` edge, updates `tenant_blob`/quota
when this was the tenant's last live reference, and clears the marker last.

Repair is the saga driver, owned by the tenant DO (the single writer of both its
`narinfo_deletion` markers and its D1 edges) and driven by the existing
`runGarbageCollection`/`runVerification` pass. It re-runs that sequence for any
surviving marker, and the replay is correct because every step is idempotent
under the captured per-version identity: the edge retirement targets the exact
captured generation, so a stale or replayed deletion can only ever remove that
generation's edge and never a newer recommitted one; `tenant_blob`/credit
re-checks references; the R2 narinfo delete is idempotent; and the marker is
cleared last. Fine-grained phase-marker columns are deliberately not used: under
captured-identity idempotency they close no correctness gap, and would only let
replay skip a few no-op steps at the cost of a migration and extra state that
can drift. The re-drive must be a bounded batch (a `limit`/cursor, like the
verify pass); an unbounded flush of every queued deletion is acceptable only as
an interim single-tenant shape and must become bounded for the hosted fleet. A
`blob_ref` edge whose narinfo row is absent is reconciled only by the owning
DO's re-drive; the reaper never deletes edges. With row-first commit there is no
commit-side rollback saga: a crashed commit is just a not-servable narinfo the
sweep removes.

Because there is no `servable` flag in any step, "not-servable" is not a stored
bit — the final serve predicate is simply that the materialised R2 narinfo
object exists (plus admission/`readMode` at the edge). The sweep classifies a
narinfo row by its R2 object, edge, and `blob_state`. A row whose R2 narinfo
object is missing is in-flight or stranded and is resolved by the rest of the
saga state: (a) no live edge, no `blob_state`, and no live `pending_upload`
means a crashed pre-reservation commit — reclaim the row; (b) a live edge plus
`available` `blob_state` but no R2 object means a crashed pre-materialise commit
or a demote heal — re-materialise the object (servable); (c) a live
`pending_upload` (`verdict = 'pending'`) means it is still verifying — leave it
for the verify pass. A row whose R2 object exists is already servable.
Servability is thus a derivable predicate, not prose.

A reuse commit (no staging to re-promote) re-heads the canonical object at
commit and returns a clean, attributable error if it is gone, before writing the
narinfo or the edge — so a reaper that collected the object in the
negotiate-to-commit window forces a re-negotiate-and-upload, never a dangling
narinfo. After inserting its edge and clearing `delete_after`, the reuse path
re-reads `blob_state` and fails (forcing re-upload) if the row was concurrently
reaped.

If the canonical shared object disappears while `blob_state` says `available`,
the global reaper's demote pass (not the per-DO verify pass, which cannot scan
global `blob_state`) removes the `blob_state` row. Because the read path serves
from the materialised narinfo R2 object and never from `blob_state`, demotion
also removes or short-TTLs the referencing narinfos' R2 objects and purges the
edge cache, routed through each owning tenant DO's repair queue; removing
`blob_state` alone stops no read. Any tenant's correct re-upload heals it.

### Existence-oracle defence

Negotiate gates skip/upload only on the asking tenant's own edges, never on
global blob existence. A tenant that does not already reference a blob is told
to upload even when the bytes already exist globally. The server dedupes at rest
after upload and verification. Deduplication is storage-only, never a wire-level
existence oracle.

There remains a weaker servability-latency signal: after a tenant has uploaded
the bytes, a blob already present in the shared CAS may become available faster
than a genuinely new blob. V5 documents that residual and does not add
artificial delay. A strict uniform-pending privacy mode is a future extension.

### Server-side NAR verification

The V4 server signs the client-asserted uncompressed `NarHash` after checking
only the compressed `fileHash`. V5 verifies the uncompressed NAR server-side.

- Commit binds `(storePathHash, narHash, narSize, fileHash)` into the
  write-JWT-authenticated request.
- The server streams the staging `.nar.zst` through `node:zlib`
  `createZstdDecompress()`, a byte counter, and
  `crypto.DigestStream('SHA-256')`, comparing the digest to `narHash` and the
  count to `narSize`. `crypto.subtle.digest` is one-shot and unsuitable for this
  path.
- The Web-stream/R2 to Node-stream/zlib to Web-stream/DigestStream bridge must
  be backpressure-safe. Tests prove that a multi-hundred-MB stream does not
  buffer the whole output.
- The runtime spike sizes the one named config default, `verifiableMaxBytes`.
  The benchmark search starts around a 10-20 GiB verifiable cap; the provisional
  value is 4 GiB. Every fresh upload verifies in the background pass (there is
  no inline tier; the commit WebSocket parks until the verdict), so the spike is
  a **measurement, not an enabler**: it must confirm the background pass holds
  its CPU and memory budget on a multi-hundred-MB blob on the real account
  runtime (and `cpu_ms = 300_000`), and may then lower `verifiableMaxBytes` if
  the measurements demand it.
- A blob whose declared NAR size exceeds `verifiableMaxBytes` is rejected
  synchronously at commit with `413`; it could never be served.
- A background-pass mismatch deletes the staging object and records a durable
  `mismatch` verdict on the upload. It never writes a negative verdict to global
  `blob_state`.
- DO init calls `createZstdDecompress` once and fails loudly if the runtime
  lacks native zstd.

Strict verify-before-serve is the V5 baseline. There is no warn-only mode in V5.

The push contract changes accordingly. `cupboard push` waits by default for its
uploaded blobs to reach `available`, reporting progress through the existing
`Reporter`. A successful push means clients can substitute. `--no-wait` returns
with pending blobs for CI that does not need to block. A root update activates
only once all its target narinfos are available, so a root never advertises an
unservable path.

`push` waits on the commit WebSocket itself: a deferred upload's socket parks
until the verification pass delivers the verdict, so the client never polls.
Root-activation asks the tenant DO, by `(cache, storePathHash)`, for the **same
availability predicate as serving** — the materialised tenant narinfo R2 object
exists (which the DO's classifier confirms only when the edge exists,
`blob_state` is `available`, and the shared R2 blob is present, repairing if
needed). It must **not** activate on narinfo-row + `blob_state` alone: a root
would then advertise a path whose tenant narinfo object is not yet materialised
— an unservable path. Root-activation and serving thus share one
classifier/repair path. A settled upload leaves no residue: the background pass
notifies the parked waiters, then clears the `pending_upload` row and its
staging object. A failed upload's row instead turns terminal (`mismatch` or
`over-quota`) and is retained, so a waiter that lost its socket can re-drive the
commit and still hear why the path never became servable. The anti-resurrection
guarantee: the verify pass only re-drives `verdict = 'pending'`, so a terminal
row is never re-promoted. The parked socket settles on `servable` (reported as
committed), hard-errors on `mismatch` or `over-quota` (it must not hang on a
failed deferred blob), or times out client-side; `--no-wait` returns `pending`
as soon as the deferral is stored.

### Tenant auth and issuer

Each tenant's issuer is its path-based URL: `https://<host>/t/<tenant>`. Tokens
minted by a tenant DO pin that issuer and audience, so cross-tenant replay is
rejected at the JWT layer.

`tenant_identity` is the sole identity source for a tenant DO; there is no
env/default fallback. A cold-started DO whose `tenant_identity` row is absent
returns `503 not configured` for every tenant route rather than defaulting
issuer and audience to the literal `cupboard` and seeding the owner rule from
operator env — otherwise an un-configured DO could mint a token cross-verifiable
at any other un-configured DO (collapsing per-tenant issuer isolation) or take
over the owner rule. `cupboard`/`cupboard` is not a valid mintable or verifiable
tenant identity. This 503 is scoped to tenant DOs (`idFromName(tenant)`), not
the bare-host control surface or local-dev.

The DO learns its identity through a `configure` RPC that the Worker calls at
provision time and on config-version bumps; it persists the identity in a
single-row `tenant_identity` table. `config_version` is a monotonic fence
carried on every dispatch: `configure` is compare-and-set (ignore version at or
below the applied one; apply and re-seed for a greater one); on a dispatch
carrying a greater version the DO self-configures before serving; on a lesser
version it serves under its current DO-authoritative identity, never an older
one. The owner re-seed runs in one `blockConcurrencyWhile` section (only the
clear-owner path has an absence window). A request header is never the identity
source; the Worker strips any client value. `/t/<tenant>/.well-known/*` (AS
metadata and JWKS) and `/t/<tenant>/pubkey` (the Nix narinfo signing key,
distinct from the OAuth JWKS) route to that tenant's DO; bare `/.well-known/*`
and `/pubkey` serve the control plane only; `authIssuer()` sources the issuer
from `tenant_identity` so a minted token's `iss` equals the advertised tenant
issuer.

### Tenant lifecycle

Tenant creation requires an explicit `readMode: public | private`; private is
the hosted default. Enforcement reads `readMode` (and the per-tenant read
verifier) from the KV admission manifest on the read path, so a private tenant
rejects unauthenticated reads from the moment it can be created — no window
where the default mode lacks a data source.

Suspension stops writes immediately (the Worker's authoritative D1 status read
before write dispatch) and reads eventually, as described in the admission
model.

Offboarding is a state machine, not a bare Worker delete cursor. The tenant is
marked `offboarding` in the registry (admission rejects new writes; the cron
stops dispatching ordinary GC for it); the DO halts its own
verify/promote/deletion queues so the drain does not chase newly-created edges;
in-flight commits settle; then a `runOffboard`/`drainEdges` RPC on the tenant's
DO deletes a bounded batch of its `blob_ref`/`tenant_blob` rows per tick inside
`blockConcurrencyWhile` — preserving the per-tenant single-writer rule (the
Worker must not delete a tenant's edge rows directly; a stray in-flight commit
could otherwise resurrect a row the reaper then treats as live, a permanent
invisible leak). The Worker may delete the tenant's `t/<tenant>/...` R2 objects
directly (content-addressed, idempotent). Ordinary maintenance and offboarding
are mutually exclusive per tenant: the fan-out enumerates only
maintenance-eligible tenants, and verify restore (`ensureNarInfoObject`) no-ops
for an offboarding tenant so it cannot resurrect objects the drain just deleted.
R2 prefix object-lifecycle rules are a small-fleet optimisation only, because R2
caps lifecycle rules at 1000 per bucket; rules are reaped after use.

### Cron fan-out

`scheduled()` enumerates maintenance-eligible tenants from D1 (excluding
suspended and offboarding) and fans out `runGarbageCollection()` and
`runVerification()` per tenant DO. A single Worker invocation caps subrequests
(~1000 on paid), so one RPC-pair per tenant exhausts the budget at ~500 tenants:
sharding is part of this step, not a later optimisation. The per-tick tenant
batch is bounded by a measured constant well under the budget, selecting the
most-overdue active tenants by a `tenant.last_maintained_at` column and stamping
them, so the table carries its own round-robin position (no separate cursor) and
a full sweep completes within a day. The cron fires hourly (not daily) so the
bucketing is meaningful and the latency bound holds; `wrangler.jsonc` `crons` is
updated to match. The fan-out records per-tenant failures (count and last error)
rather than swallowing them with bare `allSettled`. The global reaper gets its
own reserved budget after fan-out, or its own cron tick, so a long fan-out
cannot starve it; its demote scan resumes from its own KV-held position. Reaper
reclamation latency has a stated upper bound — grace plus at most one reaper
interval plus scan-coverage time — for physical R2 reclamation; quota credit, by
contrast, is released immediately on the DO-side 1-to-0 edge removal,
independent of the reaper. Queues remain the fallback past single-Worker-scan
scale.

### Data model

New D1 database `CUPBOARD_DB`:

- `tenant(...)`:

  ```text
  tenant(
    id PK,
    status,
    read_mode,
    owner_issuer,
    owner_subject,
    owner_audience,
    config_version,
    created_at
  )
  ```

- `tenant_usage(tenant PK, bytes, narinfos, blobs, quota_bytes, updated_at)`
- `global_admin(id PK 'singleton', issuer, subject, claimed_at)`
- `control_trust(...)` for the control-plane trust policy (`iss`, `aud`, `sub`,
  and exact-match claim map), seeded by the gated claim
- `control_auth_key(id PK, kid, public_jwk, wrapped_private_jwk, created_at, retired_at)`.
  The private JWK is stored AES-256-GCM-wrapped under `CONTROL_KEY_WRAP_SECRET`,
  which is **bound only on the control-plane Worker**. The `CupboardServer`
  Durable Object runs in a **separate `cupboard-tenant` Worker script** that
  never binds that secret, so although every tenant DO binds `CUPBOARD_DB` and
  can read this row, it has no handle to the wrapping secret and cannot recover
  the key. The Worker mints with the unwrapped private key and publishes the
  public set.
- `blob_ref(...)`:

  ```text
  blob_ref(
    tenant,
    cache,
    store_path_hash,
    generation,
    nar_hash,
    PK(tenant, cache, store_path_hash, generation)
  )
  ```

  `blob_ref` carries a secondary index on `nar_hash` (the reaper's reference
  probe, a non-key column).

- `tenant_blob(tenant, nar_hash, file_size, PK(tenant, nar_hash))`
- `blob_state(...)`:

  ```text
  blob_state(
    nar_hash PK,
    file_hash,
    file_size,
    compression,
    nar_size,
    verified_at,
    delete_after?
  )
  ```

  `delete_after` is armed only by the reaper and cleared by promote and
  reuse-commit; an index on `delete_after` backs the reaper's candidate scan.

- No cursor tables. The maintenance sweep's round-robin position lives on the
  data it maintains — a `tenant.last_maintained_at` column (with a
  `(status, last_maintained_at)` index), oldest-first — and the reaper's demote
  scan keeps its resume position in a single KV value (`CRON_STATE`), cron
  bookkeeping rather than relational data. The self-draining reaper arm and
  collect passes need no stored position at all.

`tenant.status` is one of `active`, `suspended`, `offboarding`; `read_mode` and
the per-tenant read verifier are projected into the KV manifest, not read from
D1 on the GET path.

Per-tenant DO SQLite changes:

- Add `tenant_identity` with slug, issuer, owner triple, and config version.
- Add `generation_seq(cache, store_path_hash, next_generation)`, the durable,
  never-reset per-store-path generation counter (advanced at commit; survives
  delete and offboarding). It has no `tenant` column — the DO is tenant-scoped,
  so this per-tenant table must not gain one. Add a `generation` column to
  `narInfos` recording the live row's generation, sourced from `generation_seq`,
  for compare-and-delete.
- No `servable` flag, in any step: servability is the materialised narinfo R2
  object (the row already exists before verify, so "not servable" is encoded by
  row-without-object), and in-flight/failed status lives in
  `pending_upload.verdict`. Step 6 adds quota without a flag: a cheap read-only
  pre-verify check early-rejects a clearly over-quota upload (saving verify CPU,
  advisory), and the authoritative idempotent charge stays in the existing
  post-verify atomic batch gated on the `tenant_blob` 0→1 insert. (Recorded
  deviation from the original "track servability per narinfo".)
- `pending_upload` keeps its async verification verdicts from step 1: `pending`
  while a deferred blob awaits the background pass, then a terminal `mismatch`
  (the NAR-hash check failed) or `over-quota` (the canonical size exceeds the
  tenant quota) on failure. A settled upload's row clears once its waiters are
  notified; a failed upload's row is retained terminal so a reconnecting waiter
  still hears the verdict. An over-budget blob (above `verifiableMaxBytes`) is
  rejected at commit, never deferred.
- Move blob lifecycle to D1: `nar_blob` (already removed) and
  `orphan_blob_deletion` (removed in 2c) are superseded by `blob_ref`,
  `tenant_blob`, `blob_state`, and the global reaper.
- Extend `narinfo_deletion` with the captured `(nar_hash, generation)`; the row
  itself is the durable delete-saga marker (no timestamp phase columns), and its
  surviving-marker re-drive — a bounded batch — is the DO-owned repair pass,
  correct by captured-identity idempotency.

R2 keys:

- `nar/<narHash>.nar.zst` for the shared verified CAS.
- A per-tenant staging key for unverified uploads.
- `t/<tenant>/narinfo/[<cache>/]<hash>` for per-tenant narinfo objects.

`internalOrigin` purge-skip and `narInfoCachePath` helpers gain the tenant
segment.

### Platform gate

Native `node:zlib` zstd is present in workerd source and has production reports,
but Cloudflare's public zlib docs do not list zstd. No shared-CAS work depends
on unmeasured zstd behaviour.

The first V5 step is a runtime spike on the real account runtime and under
Miniflare/`vitest-pool-workers`. It must confirm:

- `createZstdDecompress` exists and streams;
- the DO honours `limits.cpu_ms = 300_000`;
- native zstd plus SHA-256 throughput on a multi-hundred-MB fixture;
- bounded peak memory under backpressure through the Web/Node/Web stream bridge.

If the spike fails, the fallback is a streaming WASM decoder at higher CPU, with
the size cap re-evaluated from those measurements.

### Implementation sequence

Each step leaves a working cache. Control-plane auth lands before provisioning;
routing lands only once tenants exist; the push contract lands in server and CLI
together.

1. **Single-tenant verify-before-serve (runtime spike deferred).** Add
   `verifyDecompressedNar`, the backpressure-safe bridge, the zstd init
   self-test, inline and background verification, strict verify-before-serve,
   per-upload async verdicts, `CheckDiscrepancyKind` extensions, and
   `limits.cpu_ms = 300_000`. Still single-tenant. The spike itself — measuring
   real workerd zstd+SHA-256 throughput, confirming the DO honours
   `cpu_ms = 300_000`, and proving bounded peak memory on a multi-hundred-MB
   fixture — needs a deploy to the operator's account, so it is deferred. The
   provisional `verifiableMaxBytes` is 4 GiB; every fresh upload goes to the
   background pass, so the deferred contract is exercised on every push. The
   spike is a measurement, not an enabler: it confirms the background pass holds
   CPU and memory on the real runtime and may lower `verifiableMaxBytes` from
   the measurements, alongside the multi-hundred-MB bounded-memory and
   `node:zlib` self-test-failure tests.
2. **D1 substrate + per-narinfo edges + shared-CAS.** Sub-commits: **2a**
   `blob_state` replaces `nar_blob` (done); **2b** `blob_ref` (with its
   `nar_hash` index) + `tenant_blob` + the durable `generation_seq` counter,
   row-first/edge-last commit (no `servable` flag — servability is the
   materialised R2 object), and row-first/edge-last delete whose durable saga
   marker is the `narinfo_deletion` row (captured `(nar_hash, generation)`, no
   timestamp phase columns) + the DO-owned bounded repair pass that re-drives
   surviving markers (correct by captured-identity idempotency), reference
   checks moving from local `narInfos` to `blob_ref`, derived counts; **2c** the
   two-pass arm-then-collect reaper over `blob_state` (`delete_after` index,
   D1-first/R2-last), `delete_after` cleared on promote and reuse-commit,
   retiring `orphan_blob_deletion`. In this single-tenant step the reaper runs
   in the DO's maintenance pass as a bounded batch that drains over ticks, and
   "available but no object" is handled by the per-narinfo verify reconciliation
   retiring the edge so the reaper then collects the fact; the reaper's own
   resume position (a KV value) and the dedicated global demote scan land with
   the Worker-level reaper in step 7, where the reaper must see every tenant's
   references. **2d** the crash matrix. The crash tests are planted-state plus
   repair-convergence (the harness cannot evict a DO or interrupt mid-body): run
   the real path to the named step, assert the actual intermediate D1 + DO + R2
   state, then run repair/reaper and assert convergence; inject
   genuinely-between-stores faults at the R2/D1 call boundary. Still
   single-tenant data on the new model.
3. **Control-plane auth.** Add `control_auth_key` (public metadata and the
   wrapped private JWK in D1); move the `CupboardServer` Durable Object into its
   own `cupboard-tenant` Worker script that never binds
   `CONTROL_KEY_WRAP_SECRET`, so the wrapping secret is reachable only by the
   control-plane Worker, which reaches the DO through an external binding
   (`script_name`); bare `/token` RFC 8693 exchange with claim-based
   control-trust checks; control issuer/audience; bare `/.well-known/jwks.json`;
   PKCE-loopback and device login against the control issuer; key rotation and
   last-key refusal.
4. **Registry + gated bootstrap + provisioning + admission.** Add `tenant`,
   `global_admin`, and `control_trust`; implement the gated first signup claim;
   add operator admin API and `cupboard tenant create/list/suspend/delete`; add
   the KV admission manifest and version gate. Provisioning works here; cache
   routing/serving lands in step 5.
5. **Tenant routing + DO identity + per-tenant auth + private reads.** Add
   `/t/<tenant>/` resolution via the manifest, `configure` RPC,
   `tenant_identity`, per-tenant issuer/AS metadata/JWKS, owner seeding,
   `readMode`, and private-read enforcement from creation. The Worker admits a
   slug against the KV manifest before instantiating any DO (an absent slug is a
   404), enforces `readMode` and the per-tenant read verifier from the manifest
   entry on the GET path (a private cache with no verifier fails closed), and
   for a write does an authoritative D1 `tenant.status` read first — a suspended
   or offboarding tenant is a 403. `tenant_identity` is the sole identity
   source: an unconfigured tenant DO returns 503 for every route rather than
   minting or verifying under the literal `cupboard` default. The per-tenant
   read verifier is a hashed credential carried in the manifest, never the
   global `CUPBOARD_READ_USER`/`PASSWORD` env (those are retired) and never a
   plaintext secret in KV. Writes to any non-default tenant were refused with
   501 until step 6 plumbed tenant-scoped storage; that gate is now lifted.
6. **Multi-tenant upload path + push contract.** The narinfo R2 object key
   (`narInfoObjectKey`) and the read-path edge-cache key now carry a tenant
   segment, so distrusting tenants never collide on `narinfo/<hash>` or the edge
   cache; the negotiate reuse lookup is existence-oracle-safe (gating on the
   asking tenant's own `tenant_blob`/`blob_ref`, never global `blob_state`); the
   per-tenant-per-`narHash` quota is charged on the canonical size with a
   read-only pre-verify early-reject; the non-default-tenant write gate is
   lifted, so a tenant writes through the Worker to its own object; the
   per-upload status query (`servable`/`pending`/`mismatch`/`over-quota`/
   `absent`, keyed on `uploadId`, mapping the durable per-upload verdict) is in
   place (the commit WebSocket has since become the wait channel, with a failed
   upload's row retained terminal); the cron fans out maintenance to every
   active tenant, so a non-default tenant's deferred uploads reach the
   background verify pass (the unsharded fan-out; the cursor, subrequest budget
   and global reaper are step 7); and the push contract waits. Root activation
   gates on the serve predicate: `RootsService` reuses one
   `NarInfoObjectsService.isServable` (the materialised narinfo R2 object
   exists, repairing a merely-lost object first) for both the activation check
   and the summary `present` flag, so serving, root activation, and root
   summaries cannot drift; setting a root over a not-yet-servable target is
   refused with a typed 409 and leaves the existing root intact. The CLI `push`
   waits by default for its deferred uploads to become servable (parked on the
   commit socket, failing fast on `mismatch`/`over-quota`, bounded by
   `--wait-timeout`) before recording retention, so the gated activation is
   admitted; `--no-wait` returns with the paths pending and records no retention
   over them. The CLI token cache is keyed per target (origin plus any
   `/t/<slug>`), one file per target, and binds a cached token to its target
   before reuse: the signed issuer must equal the target (a tenant mints `iss`
   equal to its base URL, the control plane equal to the bare host), and the
   audience must admit it, closing V4 finding C. **Step 6 is complete.** The
   earlier gating notes, kept for context: existence-oracle-safe negotiate
   gating on the asking tenant's own `tenant_blob`/`blob_ref` (this reworks 2b's
   single-tenant reuse lookup, which consults global `blob_state` — a known,
   accepted cost); per-tenant-per-`narHash` quota — a read-only pre-verify check
   (early-reject to save verify CPU) plus the authoritative post-verify charge
   gated on the `tenant_blob` 0-to-1 insert, no `servable` flag needed; usage;
   the per-upload status query the push contract polls; server
   wait/no-wait/root-activation states and the CLI behaviour; the token cache
   keyed on the full tenant base URL (origin plus `/t/<slug>`), with decoded
   `iss` checked against the full path-based tenant issuer URL and `aud` against
   the target (the CLI token-store gains a per-target dimension).
7. **Cron fan-out + global reaper + offboarding.** _(Done.)_ The hourly cron
   tick runs four sequential passes, each isolated so one stalling never holds
   back the next and their failures surface together as an `AggregateError`: the
   maintenance sweep maintains a bounded batch of the most-overdue active
   tenants ordered by a `tenant.last_maintained_at` column, stamping them so the
   table carries its own round-robin position (no cursor table) and a full fleet
   sweep completes over successive ticks within the subrequest budget (sharding
   required not optional), the offboard drain, and the blob reaper's collect and
   demote passes on their reserved budget after the fan-out. The reaper runs
   Worker-side, the only actor that sees every tenant's edges: it arms and
   collects unreferenced `blob_state` (self-draining, no stored position), and a
   demote pass keyset-paginates `blob_state` by `nar_hash` from a resume
   position held in a single KV value, heads each canonical object and, on
   confirmed absence, de-materialises the referencing narinfos through their
   owning tenant Durable Objects before deleting the fact last, so the fact
   re-drives an interrupted demote; the `blob_state` delete is fenced on a
   `verified_at` the promote now advances, so a concurrent re-promote is left
   intact. Offboarding is the quiesce-then-drain state machine: the control
   plane marks the tenant `offboarding` (stopping writes at once and reads after
   the manifest TTL) and signals the Durable Object so an in-flight commit
   settling after the flip cannot re-materialise an object the drain removes;
   the offboard pass, disjoint from the maintenance sweep, drains bounded
   batches of the tenant's `blob_ref`/`tenant_blob` rows **through its own
   Durable Object** (the single writer, so a stray commit can never resurrect a
   drained edge) and deletes its `t/<tenant>/` R2 objects through the Worker,
   the freed shared blobs collected by the reaper. A fully drained tenant is
   finalised into a terminal **scrubbed `offboarded` tombstone**: its Durable
   Object storage (keys, identity, narinfos) is wiped, its registry row scrubbed
   of its read credential and its usage row dropped, and the manifest
   republished without it, so admission no longer spins up an object for the
   slug and `ensureTenant` refuses to re-provision it. Finalisation is
   purge-first and the drain tolerates an already-purged object, and the sweep
   reconciles a manifest left stale by an interrupted finalisation, so the
   lifecycle converges from any crash point. Object-lifecycle rules remain a
   small-fleet optimisation, unused. **Step 7 is complete; the V5 build sequence
   is done.**

### Verification

- `pnpm check` green per commit; `pnpm test:e2e` green. Every D1 and DO schema
  change has a real migration.
- Stream verification tests cover match, mismatch, the oversize (`413`)
  rejection, and the streaming size-overrun (zstd-bomb) early abort. The
  multi-hundred-MB bounded-memory (no-whole-buffer) proof and the `node:zlib`
  self-test-failure test land with the deferred runtime spike (step 1).
- Per-narinfo identity and accounting tests cover replayed commit not
  double-charging or double-referencing (the charge gated on the `tenant_blob`
  0-to-1 insert); two narinfos in one tenant sharing a `narHash`; decrement
  replay; over-quota commit rejecting the atomic batch and leaving no edge and
  no charge; a full delete at generation N then a recommit reproducing the same
  `narHash` picking generation greater than N so the replayed N-deletion no-ops
  (asserting `generation_seq` survives the delete and offboarding); quota races;
  and bytes charged once per tenant per unique `narHash`.
- Negative-verdict isolation tests show that a bad upload is quarantined on its
  staging upload and does not write global `blob_state`, while a correct upload
  of the same `narHash` still verifies and becomes available.
- Cross-store crash tests are planted-state plus repair-convergence (the harness
  cannot evict a DO or interrupt mid-body): run the real path to the named step,
  assert the actual intermediate state, then run repair/reaper and assert
  convergence. They cover edge/no-row not occurring under row-first commit;
  row/no-edge converging with no permanent blob or quota pin;
  available/no-object demoting `blob_state` and removing the referencing
  narinfos' R2 objects (for a blob referenced by a different tenant than the
  pass that runs); object/no-state healing on re-promote; a reaper crash between
  the `blob_state` delete and the R2 delete leaving an adopted orphan object; a
  delete crashed mid-markers driven to completion by the next GC tick; a
  recommit of a just-reaped `narHash` starting with `delete_after` NULL; same-DO
  commit/commit and commit/delete interleavings; and canonical
  `FileHash`/`FileSize` served from `blob_state`.
- Control-plane auth tests cover control issuer distinct from tenant issuers,
  disjoint bare vs tenant JWKS, `/token` claim checks, rotation, last-key
  refusal, gated claim refusal for wrong principals, the claim as one atomic
  batch (a crash cannot leave an un-administerable deployment), and the control
  private key being unreachable by a tenant DO.
- Tenancy tests cover A's token rejected at B, A's narinfo invisible at B,
  admission never instantiating a DO for an unprovisioned slug, an un-configured
  cold-started tenant DO returning 503 rather than minting or serving under a
  default identity (and tokens from two un-configured DOs not cross-verifying),
  `config_version` as a monotonic fence, client-supplied identity headers
  ignored, suspension stopping writes immediately via the Worker's authoritative
  D1 status read, private tenants rejecting unauthenticated reads from creation
  enforced from the KV manifest, `/t/<tenant>/pubkey` verifying that tenant's
  narinfo signature with the advertised issuer equal to a minted token's `iss`,
  a token cached for tenant A never sent to tenant B on the same origin, and
  offboarding draining edge rows through the DO without ordinary GC resurrecting
  a draining tenant's objects.
- Push UX tests cover push waiting until substitution succeeds, `--no-wait`
  returning pending, roots activating only when targets are available, and a
  background mismatch terminating `push --wait` with a hard error (not hanging)
  via the commit socket's verdict frame.
- Runtime validation records CPU limit, throughput, bounded memory, and
  Miniflare zstd availability before setting the size thresholds.

## Post-V5 Operations

This is the operational hardening that should land before feature work moves on
to V6. It is not a change to the substitution protocol; it makes the hosted
maintenance path observable enough to run.

- [x] Add durable per-tenant maintenance failure records in D1. Each cron-driven
      pass records `(tenant, pass)` with `consecutive_failures`, `last_error`,
      `last_failed_at`, and `last_success_at`. The first useful pass names are
      `maintenance` and `offboard`; future tenant-routed passes reuse the same
      table rather than inventing their own failure counters.
- [x] A failing tenant still does not block the fleet: the pass continues to use
      `allSettled`, advances the cursors it already owns, throws an
      `AggregateError` for logs, and writes the durable failure row for
      dashboards and API surfaces. A successful pass resets that tenant/pass
      counter and records `last_success_at`.
- [x] Use the authoritative D1 tenant status as the final write gate before a
      commit materialises a narinfo. The in-memory offboarding flag may remain
      as a same-instance fast signal, but correctness rests on the row still
      being `active`; `suspended`, `offboarding`, `offboarded`, or a missing row
      refuses the materialisation.
- [x] Make `offboarded` terminal in the control-plane status mutators. A
      repeated delete after finalisation is an idempotent terminal result, not a
      transition back to `offboarding`, and suspend cannot move a retired slug
      to another admitted state.

Verification:

- [x] A tenant whose maintenance or offboard pass fails gets a durable failure
      row, and a later successful pass resets the counter without hiding the
      last success time.
- [x] A fleet tick with one failing tenant still maintains later tenants and
      records the failure durably.
- [x] A commit that reaches materialisation after the tenant row changes away
      from `active` publishes no D1 edge and no tenant narinfo object.
- [x] `offboarded` cannot transition back to `suspended` or `offboarding`, and a
      repeated delete for an already-offboarded slug does not republish it to
      the admission manifest.

## Post-V5 Cost Controls

This is a follow-up stage after V5 step 7 has landed and produced real
operational data and the Post-V5 Operations hardening above. It does not block
the cron fan-out, global reaper, or offboarding work in V5. The goal is to
reduce Cloudflare Durable Object duration and request charges once the
multi-tenant maintenance path is correct and observable.

Settled conclusions:

- The substitution read path should stay HTTP. It already avoids the tenant DO
  by serving materialised R2 objects from the Worker and edge cache, so
  WebSockets would not help normal Nix reads.
- Upload control requests should stay HTTP. They are short request/response
  operations around direct R2 PUTs; changing them to WebSockets would add
  protocol state without reducing the cost of verification or repair.
- WebSocket hibernation is useful only for idle status watchers. A DO cannot
  hibernate while it is actively verifying a NAR, repairing metadata, or
  awaiting storage I/O.

Implementation sequence:

1. Add usage instrumentation. Record route-level and maintenance-pass timing for
   tenant DO calls: upload negotiate/prepare/commit, `runVerification`,
   `runGarbageCollection`, deletion flush, reaper passes, OIDC token exchange,
   and commit-socket settles. Record enough detail to distinguish CPU work from
   storage wait where the platform exposes it, and keep the metrics outside the
   substitution hot path.
2. Add maintenance eligibility. _(Done.)_ Cron now uses a D1-visible eligibility
   source so it can skip active tenants with no work instead of waking every
   active tenant every tick. One row per tenant carries pending verification
   count, earliest upload/status expiry, queued narinfo deletion count, earliest
   root expiry, and the next deferred-maintenance deadline. V5 cursors remain
   the correctness mechanism; this layer is only the admission filter for waking
   a tenant DO. Eligibility fails open: a missing or stale row causes the tenant
   to be scheduled, and the stale cutoff gives periodic full reconciliation so a
   false negative cannot starve verification, deletion, expiry, or reaper work.
3. Tighten repair queue bounds. V5 step 7 already owns the correctness-critical
   bounded fan-out and maintenance passes needed to stay within platform limits.
   This follow-up uses instrumentation to add or refine cursors, limits, and
   deadlines where real cost data shows long-running repair loops, especially
   `narinfo_deletion` flushing, verify/reaper repair scans, and offboard drains
   for very large tenants. If many tenants offboard at once, add offboard
   cursoring/fairness so early slugs cannot monopolise the drain. A pass that
   reaches its limit records the next cursor/deadline so the eligibility row
   keeps the tenant scheduled.
4. Add queue-backed maintenance scheduling. _(Done.)_ Cron is now a lightweight,
   idempotent planner: it reads the same D1 eligibility, tenant status, and
   global reaper state it read before, but enqueues bounded jobs instead of
   performing all maintenance inline in the scheduled Worker invocation. Queue
   messages carry only stable task identity and routing facts, such as
   `{ kind: "tenant-maintenance", tenant }`, `{ kind: "offboard", tenant }`,
   `{ kind: "blob-reaper" }`, `{ kind: "cas-reaper" }`,
   `{ kind: "blob-demote" }`, `{ kind: "cas-demote" }`, or
   `{ kind: "control-key-retirement" }`; the Queue is not the source of truth
   for whether work is still due. If the executor intentionally runs a fixed
   bundle of global passes from one message, that bundle is named explicitly so
   outcome records and retries still identify the bounded work attempted.

   The planner also bounds enqueue volume. Duplicate delivery is safe, and the
   implementation bounds duplicate enqueue rate by the chosen batch sizes and
   cron cadence rather than adding a D1/KV `enqueued_at` guard. Such a guard
   would be a cost and backpressure control, not correctness state; a stale or
   missing guard would fail open by letting the planner enqueue work whose
   executor re-checks the authoritative state.

   The Queue consumer is the executor. It re-checks the authoritative D1 or DO
   state before doing work, calls the same synchronous cores the cron calls
   today, and records the outcome because it is the component that actually
   attempted the pass. Tenant-local work still runs through the tenant Durable
   Object, so the DO remains the single writer for tenant metadata, delete
   repair, verification cursors, usage accounting, and offboarding edge cleanup.
   Global reaper jobs still use D1 compare-and-delete predicates and route
   tenant de-materialisation through the owning DOs.

   Completion semantics move with execution: the consumer records
   `tenant_maintenance_failure` success/failure rows for tenant jobs, records
   global job outcomes in D1 when scheduling or backoff depends on the last
   attempt, and uses metrics alone only for purely observational outcomes. It
   stamps `tenant.last_maintained_at` only after a tenant-maintenance job has
   been attempted, whether it succeeded or failed, with the failure recorded
   separately, and acknowledges the queue message only after those durable
   outcome writes succeed. A persistent tenant failure should normally be
   recorded and acknowledged so the planner controls the next scheduled attempt,
   but recording that failure must also leave or set a durable next-attempt
   schedule; acking a failed message must not silence the tenant until unrelated
   state changes. Explicit queue retry/backoff is reserved for transient
   platform failures where an immediate delayed retry is useful. A dead letter
   queue is operational visibility, not correctness state.

   Consumers process Cloudflare Queue batches one message at a time for outcome
   purposes. A successful message, including a stale message that re-checks
   state and no-ops, is acknowledged independently. A transient failure retries
   only that message. One failed message in a delivered batch must not force
   successful messages in the same batch to replay unnecessarily. Duplicate,
   stale, or delayed queue deliveries remain safe because every job revalidates
   its need and leaves the existing durable markers to drive convergence.

5. Run an external NAR verification spike. If instrumentation shows server-side
   NAR verification dominates tenant DO duration or CPU, prototype moving the
   streaming decompress-and-hash work out of the tenant DO. The tenant DO still
   owns the durable state transition: it claims a pending upload, records the
   expected immutable facts, and later commits only a trusted verification
   result keyed to that immutable claim. Before committing, the tenant DO
   rechecks that the pending upload still matches the claim and has not expired,
   been superseded, or already reached a terminal verdict. The verifier may be a
   stateless Worker, Queue consumer, or other Cloudflare primitive, but it must
   not become a second writer of tenant metadata.
6. Hibernating commit WebSocket. _(Done.)_ The commit endpoint is itself the
   WebSocket: the upgrade request carries the write token, a settled commit
   answers in its first frame, and a deferred upload parks on the socket (via
   the hibernation API, tagged by `uploadId`) until the verification pass
   notifies every waiter with the terminal verdict. The durable verdict row
   remains the source of truth for terminal failures; a waiter that disconnects
   re-drives the same commit and hears the settled answer.

Verification:

- A tenant with no pending verification, expiry, deletion, or reaper work is not
  called by cron when its eligibility row is current; missing or stale
  eligibility fails open and schedules the tenant. _(Done for tenant maintenance
  eligibility.)_
- Each bounded maintenance pass resumes from its stored cursor and converges
  across repeated ticks.
- Queue-backed maintenance scheduling preserves the existing ownership model:
  cron enqueues only stable task identity, consumers record pass outcomes and
  completion stamps, and every duplicate or stale message re-checks durable
  state before mutating anything.
- The planner bounds duplicate enqueue volume while work is delayed, and delayed
  duplicate delivery no-ops after another message has already completed the same
  work.
- A consumer crash or transient failure after doing work but before recording
  the outcome stamp replays safely and converges on the same durable state.
- Moving verification out of the DO, if implemented, preserves
  verify-before-serve, quota charging, crash recovery, and the single-writer
  rule for tenant metadata. A verifier result for an old, expired, superseded,
  or already-terminal upload is rejected by the tenant DO.
- WebSocket status watches never replace durable status polling; dropping a
  socket before or after terminal status is recorded cannot lose completion.

## Future Chunked NAR CAS

This is a future storage-cost project after V5 and the post-V5 cost controls
have produced real corpus and request data. It is not part of the V5 correctness
work. The Nix substitution protocol stays unchanged: tenants still serve
narinfos and clients still fetch one `.nar.zst` URL for a `NarHash`. Chunking is
only a physical storage strategy beneath that contract.

The design should be measured before it is implemented. Whole-NAR dedupe already
catches identical `NarHash` values, so the question is whether different NARs in
the real corpus share enough large byte regions to pay for the extra R2 objects,
request fan-out, manifest reads, Worker CPU, and maintenance complexity. A rough
local probe showed useful reuse for large source trees and little reuse for
compiled binaries at a 1 MiB target chunk size, so the benchmark must report
reuse by path family rather than one fleet-wide headline number.

Suggested design:

- Keep D1 as the live-NAR root index, not as a per-chunk index. `blob_ref`,
  `tenant_blob`, and the shared NAR state continue to answer which `narHash`
  values are live. Do not write one D1 row per chunk on the commit path unless a
  later measurement proves that maintenance scanning is worse than the D1 write
  and index cost.
- Store one compact R2 manifest per `narHash`, for example
  `nar-manifest/<narHash>`. The manifest is the stored decomposition of the NAR:
  chunker version and parameters, total `narSize`, ordered chunk descriptors,
  and enough literal/framing records to reconstruct the exact uncompressed NAR
  byte stream.
- Store chunk objects in R2 under a sharded digest key, for example
  `nar-chunk/<first4>/<chunkDigest>.zst`. The shard is only an object-key
  layout; the digest remains the authority. Chunk objects are immutable and
  content-addressed.
- Prefer NAR-aware segmentation over flat content-defined chunking. Parse the
  NAR stream enough to distinguish framing, directory metadata, symlinks, and
  regular file contents. Keep small files and framing packed, but reset the
  content-defined chunker at large regular-file content boundaries so chunk
  boundaries depend on reusable file bytes, not on preceding path names or
  metadata.
- Treat embedded Nix store path references as volatile spans. When scanning
  regular-file contents, force boundaries around byte ranges that look like
  `/nix/store/<32-character-hash>-...`. That keeps changed dependency references
  from poisoning an otherwise reusable 1 MiB content chunk. The manifest records
  those spans as literals or small chunks so reconstruction still hashes to the
  original `NarHash`.
- Start with a larger target chunk size than `systemd-casync`'s default. R2
  request costs make 64 KiB chunks unattractive for cupboard. The first spike
  should compare 256 KiB and 1 MiB targets, with min/max bounds, on actual
  pushed closures.
- Preserve the existence-oracle defence. Upload negotiation must not reveal
  global chunk presence or let a tenant skip chunks merely because another
  tenant stored them. The first design deduplicates at rest after server-side
  verification, just like the V5 whole-NAR shared CAS.

The compressed NAR contract is the main risk. A narinfo advertises `FileHash`
and `FileSize` for the bytes fetched at `nar/<narHash>.nar.zst`, so cupboard
must have a stable canonical byte stream for that URL. There are two acceptable
directions:

- Keep a materialised whole `.nar.zst` object as the read-through cache and use
  chunks as the durable source of truth for cold storage. Expiring the
  materialised object must also account for tenant narinfo objects and their
  edge-cache TTLs, because a cached narinfo must not point at a deleted or
  differently-compressed NAR.
- Spike whether Nix accepts a `.nar.zst` made from concatenated independently
  compressed zstd frames. If it does, cupboard can make the canonical compressed
  NAR be the ordered concatenation of the stored compressed chunk frames.
  `FileHash` is then the hash of that concatenation and `FileSize` is the sum of
  compressed chunk sizes, avoiding runtime recompression drift. This still has a
  cold-read request cost, so hot paths should materialise the whole object
  opportunistically.

Garbage collection should follow the existing root-first shape. D1 identifies
unreferenced `narHash` roots. The chunk reaper reads those NAR manifests from R2
and removes their reference to each chunk in a paced maintenance process, or
periodically rebuilds a live-chunk mark set by scanning live manifests. The
normal commit path should not pay per-chunk D1 writes merely to make GC easier.

Implementation sequence:

1. Add a measurement-only chunking spike in the CLI or a local tool. For each
   candidate NAR, report whole compressed size, manifest size, chunk count,
   unique compressed chunk bytes, estimated R2 request cost, and reuse grouped
   by package/path family. Compare flat CDC, NAR-aware file-content CDC, and
   NAR-aware CDC with store-reference boundary cuts.
2. Add manifest encoding/decoding and reconstruction tests. Reconstructing the
   uncompressed stream from the manifest and chunk objects must reproduce the
   advertised `NarHash` and `NarSize` exactly.
3. Spike compressed serving. Test concatenated zstd frames against the pinned
   Nix version and the Worker runtime. If that fails, use whole-NAR
   materialisation as the only servable compressed representation.
4. Add chunk storage in measurement or shadow mode behind the existing whole-NAR
   upload path. The cache still serves `nar/<narHash>.nar.zst` from the current
   shared object while the server records manifests and chunks for cost
   comparison.
5. Promote chunks to the durable source of truth only after the benchmark shows
   enough reuse and the cold-read/rematerialisation path has clear operational
   bounds. The read path must remain correct under cached narinfos, missing
   materialised NAR objects, reaper races, and tenant offboarding.

Verification:

- Corpus reports show chunk reuse, object counts, request-cost estimates, and
  cold-read/rematerialisation cost for representative source-heavy,
  binary-heavy, and mixed closures.
- Manifest reconstruction reproduces the exact uncompressed NAR hash and size,
  including directory ordering, file padding, executable markers, symlinks, and
  store-reference literal spans.
- The compressed serving spike proves either that concatenated zstd frames are
  accepted by Nix and stable as the advertised `FileHash`, or that cupboard must
  materialise whole `.nar.zst` objects before serving.
- Chunk dedupe does not change upload negotiation's privacy boundary: a tenant
  cannot infer another tenant's chunk or NAR presence before uploading and being
  verified.
- GC can remove manifests, chunk objects, and materialised whole-NAR objects
  without leaving a cached narinfo pointing at unavailable or mismatched bytes.

## Scheduled key retirement

`auth-key rotate` and `control-key rotate` add a new minting key and retire
nothing, so a superseded auth or control signing key stays in the verification
set until an operator runs `retire` by hand. Nothing acts on key age: a key's
`created_at` is recorded but never consumed, so a superseded key whose tokens
have long since expired can linger indefinitely, and if its private JWK is later
exfiltrated from DO SQLite or D1 it can still forge tokens that verify for as
long as it remains live. This bounds that window automatically: `rotate`
schedules the superseded key's retirement for after the longest-lived token it
could have signed has expired, and a maintenance pass performs the retirement.

The scope is the JWT signing keys only: per-tenant `auth_key` rows and the
global `control_auth_key`. The narinfo `signing_key` set is excluded. Its keys
sign long-lived narinfos and are trusted through Nix `trusted-public-keys`
pinning, which carries no expiry and migrates on the client's own schedule, so
there is no bounded time after which dropping a narinfo key is safe. Narinfo-key
retirement stays manual and staged.

This is safe for the auth and control keys because cupboard verifies its own
access tokens from its own key set, read directly from DO SQLite (auth) or D1
(control), so a rotated key is usable with no JWKS propagation delay and a
retired one disappears from verification the moment its row is updated. No
external party verifies a cupboard access token, so there is no cached JWKS to
wait on.

### Settled decisions

- The retirement time is a known quantity, not an estimate. A rotated key stops
  minting the instant its successor is added, so every token it signed expires
  by
  `rotate_time + max(adminJwtTtlSeconds, writeJwtTtlSeconds) + clockTolerance`.
  A safety margin sits on top:
  `scheduled_retire_at = rotate_time + maxTokenTtl + clockTolerance + margin`.
  The implementation sources `adminJwtTtlSeconds`, `writeJwtTtlSeconds`, and the
  access-JWT clock tolerance from the auth module rather than duplicating magic
  values in the retirement pass or key stores.
- `scheduled_retire_at` is a write-side scheduling marker, never a verification
  gate. Verification keeps selecting keys by `retired_at IS NULL`, so a key with
  a future `scheduled_retire_at` still verifies. The retirement pass is the only
  actor that bridges the two, reading `scheduled_retire_at` and writing
  `retired_at`.
- Among non-retired keys exactly one carries a NULL `scheduled_retire_at`: the
  live minting key. `rotate` inserts the new key with NULL and stamps the
  outgoing key (the one that held NULL) with its retirement time, so the NULL
  baton passes from the outgoing key to the incoming one. A later rotate
  therefore stamps only the key it supersedes and leaves an older key's schedule
  untouched. This anchors each key's retirement to the moment it stopped
  minting; re-stamping a superseded key would push a dead key's retirement later
  and widen its exposure window.
- The active minting key is structurally immune from the retirement pass: its
  `scheduled_retire_at` is NULL, so the `scheduled_retire_at <= now` predicate
  cannot select it. The existing last-key refusal stays as a second guard.
- Manual `retire` is unchanged. It remains the immediate-revocation lever for a
  suspected compromise, where breaking still-live tokens is the intent.

### Implementation sequence

1. [x] Add a nullable `scheduled_retire_at` column to `auth_key` (DO SQLite) and
       `control_auth_key` (D1), each with a real migration. Existing keys keep
       NULL.
2. [x] `auth-key rotate` and `control-key rotate` capture the current minting
       key, insert the new key with `scheduled_retire_at = NULL`, and stamp the
       captured key with the auth module's maximum token lifetime plus clock
       tolerance and a small explicit margin. The rotate response and CLI output
       report the scheduled retirement time.
3. [x] Add the retirement pass consumers. The per-tenant Durable Object
       maintenance pass (the cron fan-out's existing per-tenant work) retires
       due `auth_key` rows; the Worker cron tick retires due `control_auth_key`
       rows. Each selects rows whose `scheduled_retire_at` is non-null and at or
       before now while `retired_at` is null, sets `retired_at`, and keeps the
       last-key refusal. Both writers already own their rows, so no new write
       boundary is introduced.
4. [x] `key rotate` (narinfo) is untouched.

### Verification

- [x] `rotate` stamps only the outgoing key and leaves an older superseded key's
      `scheduled_retire_at` unchanged; two rotations before a retirement pass
      leave two keys with distinct schedules and one live minting key with NULL.
- [x] The retirement pass retires a key only at or after its
      `scheduled_retire_at`, never before, so a token minted just before its key
      was superseded still verifies for its full lifetime.
- [x] Verification selects keys by `retired_at IS NULL` and ignores
      `scheduled_retire_at`; a key with a future schedule still verifies.
- [x] The retirement pass never retires the minting key and refuses to retire
      the last live key.
- [x] The retirement pass is idempotent: a second run over an already-retired
      key changes nothing, and the hourly cadence retires late, never early.

### Future extension

This composes with automated periodic rotation: a scheduled pass that calls the
same `rotate` on a cadence self-schedules each predecessor's retirement through
the mechanism above, giving the auth and control keys a fully autonomous
lifecycle. The same propagation-free property makes it safe for these keys and
keeps it excluded for narinfo keys.

## V6

V6 carries per-path provenance as builder-signed Sigstore bundles, stored in the
shared CAS and discovered through a per-path list of descriptors. Build
provenance is the only predicate type populated initially; SBOMs and other
predicate types attach through the same path with no structural change.
Provenance is additive: it never participates in Nix substitution, and the
cache-content trust path — the tenant-signed narinfo and Nix's own NAR re-hash —
is unchanged.

V6 depends on the V5 shared CAS, reaper, D1 substrate, tenant routing, and the
push contract.

Settled decisions:

- Bundles are builder-signed against the builder's own CI provider Sigstore
  instance. cupboard stores them opaquely; it runs no Sigstore instance, mints
  no provenance, and holds no provenance trust root.
- The public/private distinction is the builder's, carried by the instance it
  signs against: the public good instance with the Rekor log for public
  artifacts, the CI provider's private instance with no public log otherwise.
  cupboard stores whichever bundle it receives, and `readMode` governs read
  access to the stored objects only.
- Bundles live in the shared CAS, content-addressed by their own digest and
  deduplicated across tenants. A per-path list of descriptors maps a store path
  to its bundles.
- The token exchange is unchanged and authorises uploads only. It sits on no
  consumer trust path.

### Invariants

- **Off the substitution path.** Nix never fetches or verifies an attestation.
  Substitution trust stays the tenant-signed narinfo and Nix's own NAR re-hash.
  Attestation is a separate provenance plane, consumed out of band by a policy
  gate.
- **cupboard outside the provenance trust path.** A consumer verifies a bundle
  with stock tooling against the trust root the bundle declares, and requires
  the bundle's in-toto subject digest to equal the path's `narHash`. cupboard's
  role is to store, bind on filing, and serve.
- **Presence never gates servability; verification fails closed.** A narinfo is
  servable under its own rules whether or not an attestation accompanies it. A
  consumer policy requiring an attestation of a predicate type rejects when the
  list omits it or a referenced bundle is absent, so omission and loss produce a
  refused promotion, never a silent acceptance.

### Discovery

A bundle is a content-addressed object in the shared CAS at `cas/<sha256>`,
deduplicated across tenants like a NAR blob — the same path pushed to several
tenants references one stored bundle. The CAS key is the bundle's own digest, so
a bundle's location is not derivable from the store path hash. Each store path
therefore carries a list: the tenant-namespaced, materialised R2 object
`t/<tenant>/attestations/[<cache>/]<storePathHash>` holding descriptors
`{ digest, predicateType, size }` that point into the CAS.

`predicateType` is a descriptor field — the in-toto predicate type — so the
namespace is open and a new predicate type attaches with no change to keys or
server code. The list admits several descriptors of one `predicateType`, so
multiple attestations of a type for a path are expressible.

Discovery is two reads, mirroring the OCI referrers-then-blob shape: fetch the
list, then fetch the chosen bundles from the CAS. Both reads sit behind the
tenant's `readMode`, and absent and unauthorised return the same response, so
the list opens no existence oracle and needs no bucket enumeration.

The consumer's verification chain anchors trust at the `narHash`, not at the
list:

1. From `storePathHash`, fetch and verify the tenant-signed narinfo, learning
   `narHash`.
2. Fetch the list and select descriptors by `predicateType`.
3. Fetch each bundle from the CAS and verify it with Sigstore tooling against
   the trust root the bundle declares.
4. Require the bundle's in-toto subject digest to equal `narHash`, and the
   predicate to satisfy policy.

Trust rides the bundle signature and the subject-to-`narHash` equality
cross-checked against the signed narinfo, so the list itself carries no trust. A
tampered or injected descriptor points at a bundle that fails subject equality
or signature verification; a stripped descriptor fails closed. A non-omission
guarantee, if wanted later, anchors the list digest in the signed narinfo, which
already re-materialises and bumps `generation` on every recommit.

### Storage, accounting, and GC

Attestation storage reuses the V5 reference-and-reaper pattern. The NAR-specific
`blob_state` is not widened — its invariant (a row exists iff a verified shared
NAR object exists, carrying the canonical compressed metadata and the
decompress-to-key check) stays strict. Bundles get sibling tables:

- `cas_object(digest PK, size, stored_at, delete_after?)` is the set of
  available shared bundles, positive facts only. A row exists iff a measured
  shared bundle object exists at `cas/<digest>`; `stored_at` records that
  content-addressed storage fact, not Sigstore, DSSE, or trust-root
  verification.
- `attestation_ref(...)` is one row per (narinfo version, predicate type,
  bundle):

  ```text
  attestation_ref(
    tenant,
    cache,
    store_path_hash,
    generation,
    predicate_type,
    digest,
    PK(tenant, cache, store_path_hash, generation, predicate_type, digest)
  )
  ```

  The `generation` matches the narinfo row, so a recommit re-references the
  path's bundles at the new generation and a stale-generation deletion removes
  only old-generation edges, mirroring `blob_ref`.

- `tenant_cas_blob(tenant, digest, size, PK(tenant, digest))` is the derived
  fact that a tenant references a bundle via at least one live edge, maintained
  across the 0-to-1 and 1-to-0 transitions and driving
  once-per-tenant-per-bundle charging.

Attestation storage is accounted separately from NAR storage. The existing
`tenant_usage.bytes` and `tenant_usage.blobs` counters remain NAR-specific, so
`narBlobs` stats continue to report only NAR blobs. New CAS counters record
attestation bundle bytes and object counts; quota is enforced against the sum of
NAR bytes and CAS bytes.

A bundle uploads to a per-tenant staging key; the server computes its SHA-256,
which is its CAS key, so verification is self-addressing with no decompression
step. At attach the server performs a filing-correctness guard — the bundle is a
well-formed DSSE/Sigstore envelope and its in-toto subject digest equals the
committed `narHash` — binding the attestation to the right path and rejecting
garbage. This is not signature verification, which stays the consumer's.

The tenant DO, the single writer of its tenant's D1 rows, promotes the bundle
into the shared CAS (idempotent, content-addressed), inserts the edge, charges
the bundle once per tenant per unique digest through separate CAS usage counters
that participate in the tenant quota, and re-materialises the list object from
the tenant's edges for that store path. Negotiation skips an already-referenced
bundle only on the asking tenant's own edges, never on global existence;
deduplication happens at rest after upload.

Ordering follows the V5 cross-store discipline: bundle-to-CAS first, then edge,
then list, failing safe toward a leaked CAS object and never a list entry
without its bundle; removal is list-and-edge first with the reaper collecting
the orphaned bundle, recovered from the durable deletion marker as the NAR
delete saga is. Store-path deletion removes only attestation refs for the
captured narinfo generation. Recommit does not automatically carry attestations
forward to the new generation; a later attach or push re-files bundles after the
filing-correctness guard passes. Offboarding drains attestation refs and
per-tenant CAS presence through the tenant DO, matching the NAR edge boundary.
The global reaper collects a bundle when no `attestation_ref` row anywhere
references its digest and `now >= delete_after`, sharing the NAR reaper's
compare-and-delete structure. Promotion clears `delete_after`, and a repair pass
demotes a `cas_object` fact whose R2 object is missing.

### Push and verify contract

The builder produces the bundle in CI, where its OIDC identity lives — for
example `actions/attest-build-provenance`, or `cosign attest-blob` against the
instance the builder trusts. `cupboard push` attaches the builder-produced
bundle to the matching path in the pushed closure by comparing the bundle's
in-toto SHA-256 subject digest with each path's `narHash`; `--no-attest` omits
attachment. Attachment does not gate root activation, consistent with the
presence invariant.

A consumer verifies at a policy gate (CD or admission), enumerating a closure's
store path hashes, fetching and verifying each required attestation, and
refusing promotion on absence or failure. `cupboard attest verify` uses the
public Sigstore trust root by default, accepts an explicit trusted-root file for
private Sigstore instances, lets the caller set the Sigstore transparency-log,
certificate-transparency-log, and timestamp thresholds, and requires an expected
builder identity, issuer, and predicate type. TUF mirror, cache, and root-update
policy is not a cupboard CLI surface; private deployments pass a trusted-root
file produced by their own Sigstore policy. In both cases the gate independently
checks that the verified in-toto subject digest equals the narinfo `narHash`;
cupboard only stores and files the bundle.

### Data model

D1 (`CUPBOARD_DB`), siblings to the V5 NAR blob tables: `cas_object`,
`attestation_ref`, and `tenant_cas_blob` as above.

R2 keys:

- `cas/<sha256>` for the shared bundle store, beside `nar/<narHash>.nar.zst`.
- A per-tenant staging key for an unverified bundle upload.
- `t/<tenant>/attestations/[<cache>/]<storePathHash>` for the materialised
  per-path descriptor list.

### Implementation sequence

Each step leaves a working cache.

- [x] **CAS generalisation and bundle lifecycle.** Add `cas_object`,
      `attestation_ref`, and `tenant_cas_blob`; stage, measure, and promote
      bundles into `cas/`; reference, charge through separate CAS usage
      counters, delete by captured generation, drain during offboarding, and
      reap them through the V5 shared-object pattern; crash-point tests for
      bundle/no-edge, dedupe-across-tenants charging each tenant once, quota
      rollback, re-reference after reaper arming, missing-object demotion, and
      decrement replay. This step does not materialise or serve descriptor
      lists.
- [x] **Attach and list materialisation.** Add the authenticated attach
      endpoint, the filing-correctness guard (well-formed bundle, subject equals
      committed `narHash`), list materialisation from edges, `readMode` on list
      and bundle reads with absent/unauthorised parity, and the
      existence-oracle-safe own-edges negotiate for bundles. Add crash-point
      coverage for an edge whose descriptor list was not materialised yet;
      recovery re-materialises the list from durable edges.
- [x] **CLI attach and verify guidance.** Add `cupboard push` bundle attachment
      and `--no-attest`; add verification with explicit identity, issuer,
      predicate type, threshold policy, optional private trusted-root file,
      narinfo signature, store-path hash, and subject-to-`narHash` checks.
      Sigstore trust remains a client-side policy decision rather than
      server-side trust enforcement.

### Verification

- Bundles dedupe across tenants — one `cas_object`, charged once per tenant —
  and the list materialises correct descriptors, including several of one
  `predicateType`.
- Discovery is two reads under `readMode`; absent and unauthorised are
  indistinguishable.
- The attach guard rejects a bundle whose subject does not equal the committed
  `narHash`; a consumer rejects a bundle whose subject mismatches or whose
  signature fails.
- A narinfo serves with no attestation; a required-but-absent attestation fails
  a gate closed; a lost CAS bundle does not affect narinfo servability.
- Sweeping a narinfo removes its `attestation_ref` rows; the reaper collects a
  bundle once unreferenced; a delete-then-recommit removes only old-generation
  edges.
- A public-good-signed bundle verifies against public roots and a
  private-instance-signed bundle against that instance's root, with cupboard
  unchanged in both.

### Out of scope

cupboard never runs a Sigstore instance, mints provenance, or holds a provenance
trust root. Nix substitution is untouched. Only build provenance is populated;
SBOMs (SPDX or CycloneDX predicate types) attach later through the same store
and list. Enumerating a path's attestations is reading the list, already
present, so a separate index is unnecessary. A non-omission guarantee for the
list, anchoring its digest in the signed narinfo, is a later hardening.

## V7

V7 replaces the two-role access model, on both the tenant Durable Object and the
control plane, with bearer capabilities carried on the same short-lived access
token. A token holds a set of grants, encoded as RFC 9396
`authorization_details`, each naming an operation and the resources it may act
on. One authoriser evaluates them, the owner becomes a wildcard grant rather
than an unconstrained code path, and a client requests the grants it needs while
the server verifies them against a trust rule. The rule binds requested
resources to verified claims as data, so a CI identity is confined to its own
resources without provider specifics living in server code. Attenuation lets a
holder exchange a token for a strictly weaker one without any server state.

Identity stays at the edge. The token endpoint still issues from an OIDC trust
rule (CI) or an interactive owner login; how a caller first proves itself is
unchanged. What changes is the shape of the authority the endpoint issues and
how every write path checks it. V7 covers both planes: the tenant Durable
Object's write and admin tokens and the control plane's admin tokens. They stay
separate issuing domains, so the model is shared but the trust boundary is not,
as the next section sets out.

### Why now

The change is cheapest before a release and while tokens are stateless:

- Access tokens are short-lived and carry no server-side record (V4). Changing
  their claim shape costs nothing to deploy; outstanding tokens expire within
  minutes.
- V5 is a fresh deploy with no field compatibility to keep, so the wire shape of
  a token and the stored shape of a trust rule are both free to change.
- The contract already declares each procedure's required authority once, in
  `meta({ scope })`. V7 enriches that declaration rather than inventing a new
  one.

Deferring the model and instead adding a second bespoke claim, a `cb_caches`
sibling to `cb_roots`, would spread enforcement across more sites and carry both
claims into a released, compatibility-bound token.

### The model

A grant is an operation paired with the resources it may act on:

- **Operations** are the verbs the server gates, one per contract procedure or
  wire route so that no path is left unguarded. On the tenant Durable Object the
  push lifecycle is `upload:negotiate`, `upload:prepare`, `upload:status`, and
  `upload:commit`; the attestation lifecycle is `attestation:negotiate`,
  `attestation:prepare`, and `attestation:attach`; retention is `root:set`; and
  the admin verbs cover `cache:create`, `cache:delete`, `narinfo:delete`,
  signing keys, trust rules, and policy. On the control plane: `tenant:create`,
  `tenant:suspend`, `tenant:resume`, `tenant:remove`, `tenant:read`,
  `control-key:rotate`, and `control-key:retire`.
- **Resources** name what an operation acts on, in three shapes. Tenant-DO cache
  operations carry a cache (an exact name) and, where the operation sets
  retention, a root (an exact name or a trailing-slash prefix) nested within
  that cache. Tenant-DO domain operations, the signing-key, trust-rule, and
  policy verbs, carry no resource: they are authority over the tenant the issuer
  has already established. Control operations carry an exact tenant slug where
  they act on a tenant (a tenant-prefix grammar is deferred, since slugs are
  single segments with no delimiter to stop a prefix matching `team-a` to
  `team-alpha`), and no resource for the control-key verbs. A grant lists only
  the fields its operations need, and a missing required field is never a
  wildcard: absence denies, and a wildcard must be an explicit selector in the
  grant. An issued grant carries only concrete selectors. Trust-rule bindings
  may derive selectors from verified claims, or require relations between the
  requested selectors, but those derivations and relations never appear in a
  token. Subset and attenuation containment therefore stay a name and prefix
  comparison.

A tenant-DO cache write reaches only the caches a grant names: a token
negotiates, commits, sets roots, and files attestations cache by cache. The
shared content store deduplicates bytes across caches, but that is a storage
fact, not an authority a token holds; a push reuses an existing blob without any
tenant-wide grant. The domain verbs sit outside this boundary, scoped to the
tenant rather than a cache. That per-cache boundary on writes is exactly what a
per-repository CI rule needs.

A grant is carried as an RFC 9396 `authorization_details` object with a cupboard
`type`: its `actions` are the operations and its type-specific fields are the
resources, following the three shapes. `cupboard_cache` carries a cache and, for
retention operations, a root selector; `cupboard_tenant` carries a tenant for
the control lifecycle verbs; and the resource-free types, one for the tenant
domain verbs and one for the control-key verbs, carry `actions` only. The access
token carries the granted array, and the same shape is what a client requests. A
token's authority is the set of its grants; an owner token holds a single
wildcard grant for its domain, so there is no separate unconstrained path.

### Two domains, one model

The model is shared; the issuing domains are not. The tenant Durable Object and
the control plane stay separate Worker scripts with separate signing keys and
the `CONTROL_KEY_WRAP_SECRET` split (V5), so a token is bound to its domain by
issuer, audience, and signature. A tenant token presented to a control route
fails verification before its grants are read, and a control token cannot act on
a tenant DO for the same reason; the two are not interchangeable. The wildcard
is per domain, because the two issuers sign disjoint token populations and
neither holds the other's key, so a control wildcard covers only control
operations and a tenant wildcard only that tenant's. The grant model runs inside
a domain it never crosses: authorisation is always verify the domain, then
evaluate grants.

### Authorisation

Each contract procedure declares the operation it needs and, where it has them,
which input fields name its resources, replacing `meta({ scope })`:

```text
.meta({ requires: 'root:set', resource: { cache: 'cache', root: 'name' } })
```

A single authoriser answers one question: does any grant on the token cover this
operation on these resources? Covering means the operation matches and each
resource selector contains the request, an exact name, or a trailing-slash
prefix that admits it. The wire-format write paths outside the contract (the
commit WebSocket, the presigned upload negotiation) call the same authoriser
with their operation and resources, so there is one decision point rather than a
role check in middleware plus a bespoke claim check in a handler.

Some write routes carry only an upload id rather than the cache and store path:
commit, upload status, and attestation attach address a stored pending row. For
these the authoriser reads the resources from that pending upload or attestation
row, not from the request input. The contract `resource` declaration therefore
names either an input field or the stored row the operation resolves.

### Issuance: request and verify

The token endpoint issues from a request, not from server-side construction. A
client presents its OIDC subject token and the `authorization_details` it wants;
the server verifies the subject token and checks each requested grant against
the matching trust rule. The check is all-or-nothing: if any requested grant is
not permitted the whole request is rejected with
`invalid_authorization_details`, so a client never silently receives less than
it asked for. The client names the concrete resource it knows from its own
context, for example the cache `pr-123`, and the server never parses a
provider's claim format to build that name.

A CI exchange must say what it wants: for a claim-bound rule (one that does not
permit a wildcard), `authorization_details` is required, so the token endpoint
never reconstructs authority from claims and "what did this job ask for?" stays
explicit. Missing details on such an exchange is `invalid_request`; an empty
array, or any detail malformed, unknown, or not permitted by the rule, is
`invalid_authorization_details`. An interactive owner/admin exchange is the
other trust class: its rule permits a wildcard, so omitting
`authorization_details` issues that wildcard, and a request only attenuates it.

A trust rule is data. It permits a requested grant when the operations are
allowed and each requested resource satisfies the rule's bindings. There are two
binding kinds:

- Claim bindings derive one requested resource from verified claims through a
  small library of provider-neutral transforms: exact equality, a named capture
  from an anchored pattern, or a slug normalisation. The claim name and the
  transform are the owner's configuration; the server holds no provider-specific
  code.
- Relational bindings compare requested resources with each other at issue time,
  for example requiring the requested root to equal the requested cache. They do
  not derive authority from claims and cannot add a resource; they only reject a
  requested grant whose concrete resources do not satisfy the relation.

For a per-PR rule the binding requires the requested cache to equal `pr-`
followed by, for instance, `slug(claim:ref)`, or the capture `n` from
`^refs/pull/(?<n>\d+)/merge$` over the `ref` claim. Either keeps the
GitHub-specific knowledge in the rule the owner wrote. The bound value is
validated against the resource's grammar, `cacheNamePattern` for a cache, before
it is trusted, so a request whose claim does not satisfy the binding, or whose
bound value would escape the namespace, is refused at issue time. The issued
token can only ever reach the asking PR's own cache, so a build that reaches the
token is confined to that cache whatever it does with it.

Refresh tokens are only issued for interactive owner/admin sessions. A
claim-bound CI exchange gets a short-lived access token and, when it needs
another one, presents a fresh provider OIDC token so the server can re-check the
current provider claims against the current trust rule. An owner/admin refresh
re-reads the trust rule and reissues the grants it currently permits, so a rule
change takes effect on the next refresh, and a refresh may present narrower
`authorization_details` to step down just as attenuation does.

### CLI UX

The stored grant-and-binding document is the authority model. The normal CLI
keeps common CI workflows out of hand-written JSON by providing presets that
expand to the same stored rule shape. The server stores the expanded rule plus
optional display metadata. Preset names such as `add-github-pr`, `push`,
`attest`, `root`, and `same-as-cache` are CLI conveniences.

Rules can be added three ways:

- Provider presets cover common workflows.
- Structured direct flags cover simple generic rules.
- `--from-file` accepts the full stored rule shape for cases where flags would
  become unclear.

The first preset is GitHub pull-request caches:

```sh
cupboard oidc-trust add-github-pr https://cupboard.example/t/acme \
  --repo owner/repo \
  --cache-template 'pr-{pull_request_number}' \
  --root same-as-cache \
  --allow push \
  --allow attest \
  --allow root
```

`add-github-pr` expands to a rule for GitHub Actions OIDC. The CLI looks up the
public repository with Octokit, using the GitHub REST API rather than parsing
HTML or constructing raw fetch calls. The first implementation supports public
repositories only and unauthenticated lookup is acceptable. Private repository
support can add authenticated Octokit later without changing the stored rule
shape.

The lookup records at least:

- repository id
- repository owner id
- canonical repository full name, for display

The stored trust rule pins stable ID claims, giving the policy a repository
identity that survives rename and transfer:

- `repository_id=<looked-up repository id>`
- `repository_owner_id=<looked-up owner id>`

The owner/repo string from `--repo` is therefore an input to discovery and a
display label. The stable ID claims form the security boundary.

GitHub lookup uses Octokit REST with a cache-capable fetch implementation rather
than raw `fetch` calls. The CLI configures Octokit with `make-fetch-happen` as
its `request.fetch`, using a cupboard-owned cache directory and
`cache: "no-cache"` for repository lookups so repeated runs perform HTTP
conditional requests when a cached response exists. The cache implementation
owns the `ETag`/`If-None-Match` and `304 Not Modified` handling; cupboard
consumes the same typed Octokit response either way. Rate-limit handling stays
GitHub-aware: the Octokit client uses `@octokit/plugin-throttling` and
`@octokit/plugin-retry` with bounded retries, `Retry-After`/rate-reset-aware
backoff, and clear terminal errors when lookup cannot complete. Avoid layering
independent retry policies: if `make-fetch-happen` is used only for HTTP
caching, its generic retry behaviour is disabled or kept subordinate to
Octokit's GitHub-specific throttling.

The predefined GitHub PR substitutions are deliberately small:

- `{pull_request_number}`: captured from the verified `ref` claim with
  `^refs/pull/(?<pull_request_number>\d+)/merge$`

Additional substitutions can be added later when there is a concrete use case.
Repository identity is pinned through exact ID claims. Template substitutions
are for derived resource names.

Templates use cupboard's small `{name}` substitution syntax. A placeholder is an
ASCII identifier in braces, such as `{pull_request_number}`. The parser accepts
that placeholder form exactly. The rendered value is always validated against
the destination grammar (`cacheNamePattern` for caches, `rootNameSchema` for
roots) before a grant is issued.

Variable values come from named substitutions. In the stored rule and
`--from-file` form, a substitution maps a template variable to a verified OIDC
claim, optionally through a transform. The first supported transforms are:

- `claim`: copy the claim value directly
- `capture`: match an anchored regular expression against a claim and use a
  named capture group
- `slug`: normalise a claim value into a bounded slug, only when the destination
  grammar allows it

Template expansion applies to template-bearing options. In the first
implementation those are `--cache-template` and `--root-template`.
`--root same-as-cache` compiles to a relational binding requiring the requested
root to equal the requested cache.

`same-as-cache` is CLI shorthand. It compiles to a binding that requires the
requested root to equal the requested cache exactly:

```json
{
  "root": {
    "equalsResource": "cache"
  }
}
```

For a job whose verified OIDC token has `ref=refs/pull/123/merge`, the
`add-github-pr` command above permits cache `pr-123` and root `pr-123`, and
refuses cache `pr-123` with root `main`, or cache `pr-124` with root `pr-124`.

The `--allow` values expand to fine-grained V7 operations:

- `push`: `upload:negotiate`, `upload:prepare`, `upload:status`, `upload:commit`
- `attest`: `attestation:negotiate`, `attestation:prepare`, `attestation:attach`
- `root`: `root:set`

A structured generic command can express the same shape with explicit repository
ids, at the cost of more flags:

```sh
cupboard oidc-trust add https://cupboard.example/t/acme \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cupboard.example/t/acme \
  --claim repository_id=123456789 \
  --claim repository_owner_id=987654321 \
  --grant cupboard_cache \
  --allow push \
  --allow attest \
  --allow root \
  --cache-template 'pr-{pull_request_number}' \
  --capture 'ref=^refs/pull/(?<pull_request_number>\d+)/merge$' \
  --root same-as-cache
```

`--capture <claim>=<anchored-pattern>` matches a verified claim and exposes each
named capture group as a template variable. The CLI splits the value only at the
first `=`, so the pattern can contain `=`, commas, colons, and additional named
groups without changing the flag grammar. One capture can therefore define
several variables from the same claim:

```sh
cupboard oidc-trust add https://cupboard.example/t/acme \
  --issuer https://example.com/oidc \
  --audience https://cupboard.example/t/acme \
  --claim project_id=abc123 \
  --grant cupboard_cache \
  --allow push \
  --cache-template '{branch}-{platform}' \
  --capture 'ref=^refs/heads/(?<branch>[a-z0-9-]+)-(?<platform>[a-z0-9-]+)$'
```

This keeps custom substitutions in the structured surface with the source claim
and pattern in one shell value, and the variable names inside the regular
expression where they are already defined.

The GitHub PR source is also available as a named shortcut:

```sh
cupboard oidc-trust add https://cupboard.example/t/acme \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cupboard.example/t/acme \
  --claim repository_id=123456789 \
  --claim repository_owner_id=987654321 \
  --grant cupboard_cache \
  --allow push \
  --allow attest \
  --allow root \
  --cache-template 'pr-{pull_request_number}' \
  --template-source github-pr \
  --root same-as-cache
```

`--template-source github-pr` expands to the `ref` capture shown above.
Repository lookup belongs to `add-github-pr`; this command takes the stable
`repository_id` and `repository_owner_id` filters explicitly. This is the middle
tier: exact claim filters, shorthand actions, template options, custom
substitutions, and named provider substitution sources. Complex resource
bindings and rules that are clearer as data use `--from-file`.

The preset command above is equivalent to this raw trust-rule file, assuming
GitHub returned repository id `123456789` and owner id `987654321`:

```json
{
  "issuer": "https://token.actions.githubusercontent.com",
  "audience": "https://cupboard.example/t/acme",
  "claims": {
    "repository_id": "123456789",
    "repository_owner_id": "987654321"
  },
  "display": {
    "provider": "github",
    "preset": "github-pr",
    "repository": "owner/repo"
  },
  "permittedGrants": [
    {
      "type": "cupboard_cache",
      "actions": [
        "upload:negotiate",
        "upload:prepare",
        "upload:status",
        "upload:commit",
        "attestation:negotiate",
        "attestation:prepare",
        "attestation:attach",
        "root:set"
      ],
      "resources": {
        "cache": {
          "equalsTemplate": "pr-{pull_request_number}",
          "substitutions": {
            "pull_request_number": {
              "claim": "ref",
              "capture": {
                "pattern": "^refs/pull/(?<pull_request_number>\\d+)/merge$",
                "group": "pull_request_number"
              }
            }
          },
          "validate": "cacheName"
        },
        "root": {
          "equalsResource": "cache",
          "validate": "rootName"
        }
      }
    }
  ]
}
```

A user can write that rule directly:

```sh
cupboard oidc-trust add https://cupboard.example/t/acme \
  --from-file github-pr-cache-rule.json
```

The file form contains the protocol shape: issuer, audience, exact claim
filters, permitted grants, and claim/resource bindings. The CLI validates the
file with the same schema as the server and posts it unchanged. The file form
may also be used for GitHub rules when the user already knows the stable ids.
`oidc-trust show` and `oidc-trust list` render the stored rule shape, optionally
annotated with stored display metadata such as provider, preset, and repository.
`--json` returns the stored rule shape. Token exchange returns the concrete
`authorization_details` granted to the caller.

Capture patterns are never evaluated with JavaScript `RegExp`. They are
evaluated with `re2js`, a pure-JavaScript RE2-compatible engine: RE2 matches in
linear time, so an admin-supplied pattern cannot trigger catastrophic
backtracking, and `re2js` needs no native binding or filesystem access to run
under the Worker runtime.

`capture` is deliberately restricted:

- patterns are compiled and validated when a rule is added
- patterns must be anchored with `^` and `$`
- unsupported RE2 features are rejected
- pattern length, input claim length, number of capture transforms, and rendered
  template length have explicit schema limits
- the requested capture group must be named and must be present exactly once
- each template variable is defined by exactly one capture group across the
  rule; a name defined twice is rejected when the rule is added, never resolved
  last-wins
- rendered resources are still validated against their destination grammar

If `re2js` stops working under workerd or cannot support a required production
constraint, V7 must fail closed: do not fall back to JavaScript `RegExp`.
Provider presets can still compile to named built-in transforms such as
`githubPullRequestNumberFromRef`, implemented with bounded string parsing, and
raw trust rules can be limited to exact-claim bindings until a linear engine is
available again.

### Attenuation

A holder may exchange a token for a strictly weaker one. The exchange is an RFC
8693 token exchange whose subject token is the current access token and whose
requested `authorization_details` are the narrower grants; the endpoint issues a
new token with those grants, and only if they are a subset of the presenter's
grants under the same covering test the authoriser uses. The new token is an
ordinary short-lived access token with fewer grants.

The exchange touches no storage. Subset is decided from the presented token's
own grants, so there is no record to consult and none to revoke; the narrower
token expires on its own schedule like any other. Attenuation is issuer-side:
the holder calls the token endpoint to narrow, reusing the existing asymmetric
signing keys and published JWKS. A privileged step narrows before handing a
token to an untrusted one, and the owner's CLI can drop to a single cache before
running a script.

Refresh is the stored-session path for interactive owner/admin logins. The
presence of a `refresh_token` member in the token response is the wire signal
that a session can refresh; claim-bound CI exchanges omit it. A refresh-token
grant consumes the presented refresh token, re-reads the current trust rule, and
issues a new access token only for grants the rule still permits. If the refresh
request also carries narrower `authorization_details`, the same subset test used
for attenuation applies before the new token is issued.

### Migration

- The access token's `scope` and `cb_roots` claims become an
  `authorization_details` claim (RFC 9396). Tokens are stateless, so no issued
  token needs rewriting.
- The token response and `.well-known/oauth-authorization-server` metadata, on
  both the tenant and control issuers, stop reporting `scope`: the response
  returns the granted `authorization_details`, and the metadata advertises
  `authorization_details_types_supported`. Scopes are gone from cupboard's own
  issuers, so `scopes_supported` simply drops out; RFC 9396 asks only that the
  supported detail types be published, not that they stand in for scopes.
- A trust rule's `scope` and `allowedRoots` columns, the tenant `oidc_trust`
  rules and the control rules alike, become a stored set of permitted grants and
  their claim bindings. V5 is a fresh deploy, so the row shape changes without a
  data migration.
- `meta({ scope })` on every contract procedure, control procedures included,
  becomes `meta({ requires, resource })`. The oRPC middleware reads that
  metadata, verifies the token, resolves the declared resources from parsed
  input or stored rows, and calls the shared authoriser. Hono wire-format routes
  use the same authoriser after they have resolved their concrete resources.
  Hono remains the routing layer; the capability decision is shared rather than
  path-specific. An owner rule seeds a single wildcard grant for its domain.

### Implementation sequence

Each step keeps a working deployment.

- [x] **Grant model and authoriser.** Define the operation and resource types,
      the grant set, and the covering test. Add the authoriser and route every
      contract procedure, on the tenant DO and the control plane, plus every
      wire-format write path, through it. Replace the `scope` claim with
      `authorization_details`; an owner rule seeds a wildcard grant per domain.
      Unit tests for covering, including the missing-field-denies rule, the
      per-domain wildcard, and a token from one domain refused on the other
      before authorisation.
- [x] **Request-and-verify issuance.** Store the permitted grants and their
      claim bindings on a rule, tenant and control alike. On a token request,
      verify each requested `authorization_details` against the rule, applying
      the generic transform library (exact, capture, slug) and re-validating the
      bound value against the resource grammar. The token endpoint never
      reconstructs authority from claims: a claim-bound (CI) rule, one that does
      not permit a wildcard, must send `authorization_details`, and missing
      details on such an exchange is `invalid_request`. An empty array, or any
      detail malformed, unknown, or not permitted by the rule, is
      `invalid_authorization_details`, refusing the whole request rather than
      narrowing it. The interactive owner/admin class is the exception: its rule
      permits a wildcard, so omitting `authorization_details` issues the
      wildcard, and a request only attenuates it. Return the granted
      `authorization_details` in the token response and advertise
      `authorization_details_types_supported` in the authorisation-server
      metadata, dropping `scopes_supported`. Tests for a satisfied binding, a
      claim that fails the binding, whole-request rejection, a CI exchange that
      omits details, and a bound value that would escape a selector.
- [x] **Attenuation and refresh.** Add the RFC 8693 exchange that narrows a
      presented token to a requested subset of its `authorization_details`,
      refusing any request that is not covered. Refresh tokens are issued only
      for interactive owner/admin sessions; claim-bound CI exchanges omit
      `refresh_token` and re-exchange fresh provider tokens. Refresh reissues
      the rule's current grants and accepts the same narrowing. Tests for subset
      acceptance, superset refusal, that a narrowed token cannot reach a
      resource the presenter could not, that CI exchanges receive no refresh
      token, and that refresh tracks a changed rule.
- [x] **CLI.** `cupboard oidc-trust add` and the control trust commands accept
      permitted grants and their claim bindings. Add the GitHub PR preset,
      shorthand action expansion, validated `{name}` template rendering,
      structured direct flags with custom substitutions and named provider
      substitution sources, raw `--from-file`, readable show/list output,
      Octokit public repository id lookup with HTTP caching and rate-limit
      backoff, and `re2js` capture evaluation under workerd. The push and attest
      actions request the `authorization_details` they need and attenuate before
      running a build.

### Verification

- A commit is refused when no grant names the cache; a commit into a cache the
  grant names succeeds, and reusing a blob another cache already holds needs no
  extra grant.
- A rule issues a token confined to the PR's own cache when the requested cache
  satisfies the claim binding; a request for a grant whose claim does not
  satisfy the binding is rejected whole with `invalid_authorization_details`; a
  bound value that fails `cacheNamePattern` is rejected at issue time.
- A resource-free grant covers a tenant domain verb such as key rotation, and a
  cache-only grant does not; neither carries a dummy resource field.
- An attenuated token reaches a strict subset of the presenter's resources and
  no more; a superset request is refused.
- An owner token's wildcard grant covers every operation in its domain; removing
  it leaves a token that can do nothing rather than everything.
- A control rule scopes an operator to a named tenant; a tenant token is refused
  on a control route, and a control token on a tenant route, before grants are
  evaluated.

### Out of scope

cupboard does not become an object-capability system. Tokens are bearer
credentials, not passable references with their own lifecycle; there is no
delegation graph, no revocation registry, and no offline caveat chaining.
Revocation stays expiry plus key rotation. The grant encoding here is a JWT
claim; Biscuit is a viable alternative encoding of the same model if offline
attenuation becomes a requirement, since only the issue and authorise code would
change. Sender-constrained tokens (DPoP or mTLS binding), which would defeat
token theft rather than only contain it, are a later hardening if the threat
model calls for them. Control tenant selectors are exact in V7; a tenant-prefix
grammar for scoped provisioning is deferred until it is needed. Per-cache read
authorisation is not addressed here: reads stay public or netrc-gated, and PR
caches are public-read, so the write boundary alone keeps an untrusted build
from reaching the default cache.

## Later features

- [ ] Import from an existing binary cache.
- [ ] Strict uniform-pending privacy mode for high-sensitivity multi-tenant
      deployments, making new references wait through the same visible pending
      state even when the shared CAS already has the blob.
- [ ] Web dashboard.
- [ ] S3-compatible migration/export tooling.
- [ ] `watch-store` mode in the CLI.
