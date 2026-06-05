# `cupboard` Plan

A Cloudflare Workers substituter for Nix.

## Non-Goals

- Federation, mirroring, or peer-to-peer between deployments.
- Replacing Hydra, Cachix, or Attic at organisational scale.
- Acting as a general HTTP file host. Only Nix store paths and their metadata.

## Tenancy

Single-tenant for now — one owner per deployment. This is a deliberate current
scope, not a permanent exclusion.

It is single-tenant structurally, not just by intent: one Durable Object per
deployment holds all metadata, roots, and keys; one deployment-wide signing key;
NAR blobs are shared (content-addressed) across caches; and one
bootstrap-derived admin governs the whole deployment. None of these is a tenant
boundary. Named caches and V4 per-repository write scopes are organisation
_within_ one owner's trust domain — shared key, blobs, and admin — not isolation
between owners.

V5 is the point where this changes. Multi-tenancy is a clean-slate hosted mode:
one Durable Object per tenant, per-tenant signing keys, per-tenant admin and
OIDC trust rules, per-tenant storage accounting, and a shared content-verified
CAS beneath those tenant boundaries. Existing single-tenant deployments stay on
the V4 line unless an operator re-pushes content into V5.

## Compatibility

- Develop and test against the current Nix the e2e suite is run with (2.33, via
  Determinate Nix, at the time of writing); that is the only version cupboard is
  verified against, and there is no compatibility guarantee for older releases.
  Supporting older clients is an explicit non-goal. zstd-compressed NARs are the
  obvious hard cliff — Nix only gained zstd substitution in 2.4 (November 2021),
  so anything older could not substitute at all — but the point is broader: we
  do not certify a minimum version, and adding fallback NAR compression for old
  clients is not worth it for a personal cache.
- The CLI orchestrates the v1 write path. Pure TypeScript code serialises NARs,
  computes hashes, compresses blobs, and speaks the cupboard upload protocol.
  The only local Nix dependency is a daemon client used to query valid path
  metadata and closure membership. The Worker owns authentication, R2 presigned
  URL generation, signing, and metadata commit. The CLI never receives R2
  credentials.
- Signing uses the standard Ed25519 narinfo format so any Nix client with the
  public key in `trusted-public-keys` can verify substitutions.

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
| POST      | `/uploads/<id>/commit`                    | write JWT          | DO. Writes the narinfo row and R2 object.       |
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
with an optional per-root TTL. Reachability GC marks the transitive closure from
every live channel through `References`. This is built in three increments:

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
- [x] Cache the admin JWT at `~/.config/cupboard/token` (mode 0600) and reuse it
      across invocations; a 401 prompts re-login. `init` and the admin commands
      take the cached token through the existing `TokenProvider` contract. A
      `refresh_token` grant is deferred.

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
DO at promote, the Worker reaper for `delete_after` and collection); the tenant
DO writes its own `tenant_usage` counters (`bytes`/`narinfos`/`blobs`, where it
charges and credits quota) while the Worker writes only that row's quota
configuration (`quota_bytes`) — disjoint columns, no write conflict; and the
Worker owns `tenant`, `control_*`, and `global_admin`.

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
must not poison hash `X` globally. A synchronous inline failure rejects the
commit and clears the upload at once — a mismatch is `422`, an over-budget blob
`413` — so it needs no stored verdict. An asynchronous background failure
instead records a durable `mismatch` verdict on the upload, so `push --wait` or
a status endpoint can observe why a deferred path never became servable.

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
`delete_after`, in two cursored, bounded passes over `blob_state` (its own
persisted cursor, distinct from the cron fan-out cursor):

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

`delete_after` is cleared to NULL by both paths that re-reference a hash:
promote (`ON CONFLICT DO UPDATE SET delete_after = NULL`) and reuse-commit (an
explicit update in the same batch as its edge insert — reuse does no promote, so
this is mandatory). The grace is the single deployment-wide
`narinfo TTL + margin` (one TTL constant, preserved from V3). The reaper also
runs a demote pass — it, not the per-DO verify pass, is the only actor that can
scan global `blob_state` — walking `blob_state` by cursor, heading the canonical
object, and on confirmed absence (same in-transaction re-check) deleting the
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
- The runtime spike sets two named config defaults: `inlineVerifyMaxBytes` and
  `verifiableMaxBytes`. The benchmark search starts around a 10-20 GiB
  verifiable cap. Until the spike runs on the operator's account these ship
  PROVISIONAL but conservative and fail-safe — not "correct at any value", since
  a too-large inline threshold can still blow the CPU or memory budget. The
  provisional `inlineVerifyMaxBytes` is small (a few MiB, within budget) and
  `verifiableMaxBytes` is set so large/background verification is effectively
  disabled: blobs above the conservative inline bound are rejected at commit
  rather than accepted unverified or deferred to an unmeasured background pass.
  The spike then replaces both with measured values from the real Workers
  runtime.
- Blobs at or below `inlineVerifyMaxBytes` verify synchronously at commit and
  become immediately servable. Larger blobs go pending and verify in the
  background pass. A blob whose declared NAR size exceeds `verifiableMaxBytes`
  is rejected synchronously at commit with `413`; it could never be served.
- An inline mismatch is rejected synchronously with `422` and its staging object
  deleted. A background-pass failure deletes the staging object and records a
  durable `mismatch` verdict on the upload. Neither writes a negative verdict to
  global `blob_state`.
- DO init calls `createZstdDecompress` once and fails loudly if the runtime
  lacks native zstd.

Strict verify-before-serve is the V5 baseline. There is no warn-only mode in V5.

The push contract changes accordingly. `cupboard push` waits by default for its
uploaded blobs to reach `available`, reporting progress through the existing
`Reporter`. A successful push means clients can substitute. `--no-wait` returns
with pending blobs for CI that does not need to block. A root update activates
only once all its target narinfos are available, so a root never advertises an
unservable path.

`push --wait` polls an explicit status query keyed by `uploadId` (which the
client already holds, avoiding a path-to-upload mapping); root-activation asks
the tenant DO, by `(cache, storePathHash)`, for the **same availability
predicate as serving** — the materialised tenant narinfo R2 object exists (which
the DO's classifier confirms only when the edge exists, `blob_state` is
`available`, and the shared R2 blob is present, repairing if needed). It must
**not** activate on narinfo-row + `blob_state` alone: a root would then
advertise a path whose tenant narinfo object is not yet materialised — an
unservable path. Root-activation and `push --wait` thus share one
classifier/repair path. The `uploadId` query needs a durable status record that
outlives the commit for any upload the client may poll — every deferred
(`pending`) upload. So a `pending` upload's `pending_upload` row is not deleted
when the background pass commits it; it transitions `pending` to `servable` (or
to `mismatch` on failure) and is reaped only after a status-observation window,
retaining the `uploadId` to `(cache, storePathHash, nar_hash)` mapping for the
poll. The anti-resurrection guarantee no longer rests on deleting the row: the
verify pass only re-drives `verdict = 'pending'`, so a terminal row is never
re-promoted (this replaces step 1's "clear the pending row in the commit
transaction" with "set it terminal" for the deferred path). Synchronous outcomes
return at commit and need no poll: inline success returns servable; inline
mismatch/too-large return `422`/`413` and clear the row (step 1's behaviour).
The query returns `servable`, `pending`, `mismatch`, or `absent`; `push --wait`
backs off and terminates on `servable`, on `mismatch` as a hard error (it must
not hang on a failed deferred blob), or on timeout.

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
batch is bounded by a measured constant well under the budget, advancing a
persisted `cron_cursor` over slug order so a full sweep completes within a day.
The cron fires hourly (not daily) so the bucketing is meaningful and the latency
bound holds; `wrangler.toml` `crons` is updated to match. The fan-out records
per-tenant failures (count and last error) rather than swallowing them with bare
`allSettled`. The global reaper gets its own reserved budget after fan-out, or
its own cron tick, so a long fan-out cannot starve it; it advances its own
`blob_state` cursor. Reaper reclamation latency has a stated upper bound — grace
plus at most one reaper interval plus cursor-coverage time — for physical R2
reclamation; quota credit, by contrast, is released immediately on the DO-side
1-to-0 edge removal, independent of the reaper. Queues remain the fallback past
cursor-sharding scale.

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

- `cron_cursor(id PK 'singleton', ...)` for fan-out tenant sharding, and a
  separate reaper cursor over `blob_state` so the reaper's scan does not share
  state with the fan-out.

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
  while a deferred blob awaits the background pass, and `mismatch` once that
  pass fails. A deferred upload's row is retained through its terminal
  `servable`/`mismatch` state (reaped after a status-observation window) as the
  durable `uploadId`-keyed record `push --wait` polls — not deleted on commit.
  Synchronous inline failures reject and clear the upload; an over-budget blob
  is rejected at commit, never deferred.
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
   fixture — needs a deploy to the operator's account, so it is deferred:
   `inlineVerifyMaxBytes` and `verifiableMaxBytes` ship PROVISIONAL but
   conservative and fail-safe — a small inline bound with large/background
   verification disabled (oversize blobs rejected at commit, never accepted
   unverified) — until the spike replaces them with measured values, alongside
   the multi-hundred-MB bounded-memory and `node:zlib` self-test-failure tests.
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
   persisted cursor and the dedicated global demote scan land with the
   Worker-level reaper in step 7, where the reaper must see every tenant's
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
   or offboarding tenant is a 403. `tenant_identity` is the sole identity source:
   an unconfigured tenant DO returns 503 for every route rather than minting or
   verifying under the literal `cupboard` default. The per-tenant read verifier
   is a hashed credential carried in the manifest, never the global
   `CUPBOARD_READ_USER`/`PASSWORD` env (those are retired) and never a plaintext
   secret in KV. Writes to any non-default tenant are refused with 501 until
   step 6 plumbs tenant-scoped storage.
6. **Multi-tenant upload path + push contract.** **Prerequisite (step-5 carry):
   the narinfo R2 object key (`narInfoObjectKey`) and the public edge-cache key
   (the tenant-prefix-stripped request URL) gain a tenant segment.** In step 5
   both are unscoped, which is harmless only because every non-default write is
   501-gated, so just `v1` holds narinfo objects; opening multi-tenant writes
   without scoping these keys would collide two tenants on `narinfo/<hash>` and
   on the stripped edge-cache key. Add existence-oracle-safe negotiate gating on
   the asking tenant's own `tenant_blob`/`blob_ref` (this
   reworks 2b's single-tenant reuse lookup, which consults global `blob_state` —
   a known, accepted cost); per-tenant-per-`narHash` quota — a read-only
   pre-verify check (early-reject to save verify CPU) plus the authoritative
   post-verify charge gated on the `tenant_blob` 0-to-1 insert, no `servable`
   flag needed; usage; the per-upload status query the push contract polls;
   server wait/no-wait/root-activation states and the CLI behaviour; the token
   cache keyed on the full tenant base URL (origin plus `/t/<slug>`), with
   decoded `iss` checked against the full path-based tenant issuer URL and `aud`
   against the target (the CLI token-store gains a per-target dimension).
7. **Cron fan-out + global reaper + offboarding.** Hourly cron; per-tick tenant
   batch bounded under the subrequest budget advancing `cron_cursor` (sharding
   required here, not optional); per-tenant failures recorded, not swallowed;
   the reaper on a reserved budget or its own tick with a stated
   reclamation-latency bound; the quiesce-then-drain offboarding state machine
   with edge-row deletion through the tenant DO (the Worker deletes only R2
   objects), mutually exclusive with ordinary maintenance; lifecycle rules a
   small-fleet optimisation.

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
  via the per-upload status query.
- Runtime validation records CPU limit, throughput, bounded memory, and
  Miniflare zstd availability before setting the size thresholds.

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

- `cas_object(digest PK, size, verified_at, delete_after?)` is the set of
  available shared bundles, positive facts only. A row exists iff a verified
  shared bundle object exists.
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

A bundle uploads to a per-tenant staging key; the server computes its SHA-256,
which is its CAS key, so verification is self-addressing with no decompression
step. At attach the server performs a filing-correctness guard — the bundle is a
well-formed DSSE/Sigstore envelope and its in-toto subject digest equals the
committed `narHash` — binding the attestation to the right path and rejecting
garbage. This is not signature verification, which stays the consumer's.

The tenant DO, the single writer of its tenant's D1 rows, promotes the bundle
into the shared CAS (idempotent, content-addressed), inserts the edge, charges
the bundle once per tenant per unique digest through the same
reserve-then-commit quota shape as NAR blobs, and re-materialises the list
object from the tenant's edges for that store path. Negotiation skips an
already-referenced bundle only on the asking tenant's own edges, never on global
existence; deduplication happens at rest after upload.

Ordering follows the V5 cross-store discipline: bundle-to-CAS first, then edge,
then list, failing safe toward a leaked CAS object and never a list entry
without its bundle; removal is list-and-edge first with the reaper collecting
the orphaned bundle, recovered from the durable deletion marker as the NAR
delete saga is. The global reaper collects a bundle when no `attestation_ref`
row anywhere references its digest and `now >= delete_after`, sharing the NAR
reaper's structure.

### Push and verify contract

The builder produces the bundle in CI, where its OIDC identity lives — for
example `actions/attest-build-provenance`, or `cosign attest-blob` against the
instance the builder trusts. `cupboard push` attaches the builder-produced
bundle to its uploaded paths; `--no-attest` omits it. Attachment does not gate
root activation, consistent with the presence invariant.

A consumer verifies at a policy gate (CD or admission), enumerating a closure's
store path hashes, fetching and verifying each required attestation against the
bundle-declared trust root, and refusing promotion on absence or failure.

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

1. **CAS generalisation and bundle lifecycle.** Add `cas_object`,
   `attestation_ref`, and `tenant_cas_blob`; stage, digest, and promote bundles
   into `cas/`; reference, charge, and reap them through the V5 machinery;
   crash-point tests for bundle/no-edge, edge/no-list, dedupe-across-tenants
   charging each tenant once, and decrement replay.
2. **Attach and list materialisation.** Add the authenticated attach endpoint,
   the filing-correctness guard (well-formed bundle, subject equals committed
   `narHash`), list materialisation from edges, `readMode` on list and bundle
   reads with absent/unauthorised parity, and the existence-oracle-safe
   own-edges negotiate for bundles.
3. **CLI attach and verify guidance.** Add `cupboard push` bundle attachment and
   `--no-attest`; document consumer verification against the bundle-declared
   trust root and the subject-to-`narHash` check, with example policy gates for
   the public good and a CI provider's private instance.

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

## Later features

- [ ] Chunk-level dedupe rather than whole-NAR storage.
- [ ] Import from an existing binary cache.
- [ ] Strict uniform-pending privacy mode for high-sensitivity multi-tenant
      deployments, making new references wait through the same visible pending
      state even when the shared CAS already has the blob.
- [ ] Web dashboard.
- [ ] S3-compatible migration/export tooling.
- [ ] `watch-store` mode in the CLI.
