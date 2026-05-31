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

Adding multi-tenancy later would mean a Durable Object per tenant (isolated
metadata and roots), a per-tenant signing key (so a cache carries the tenant's
trust identity), per-tenant admin and OIDC trust rules, and per-tenant storage
accounting. That is a materially larger product, near the "not Cachix/Attic at
organisational scale" line, so it waits for a real need rather than being
designed in speculatively.

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

- `narinfo` — one row per store path.
  - `store_path_hash` (PK), `store_path`, `nar_hash`, `nar_size`, `file_hash`,
    `file_size`, `compression`, `references_json`, `deriver`, `ca`, `sig`,
    `created_at`.
- `nar_blob` — one row per stored compressed blob.
  - `nar_hash` (PK), `r2_key`, `compression`, `file_hash`, `file_size`,
    `created_at`.
- `pending_upload` — in-flight uploads not yet committed.
  - `id` (PK), `nar_hash`, `r2_key`, `expected_size`, `metadata_json`,
    `created_at`, `expires_at`.
- `orphan_blob_deletion` — durable queue for deleting abandoned R2 objects.
  - `r2_key` (PK), `not_before`, `created_at`.
- `narinfo_deletion` — durable queue for finishing interrupted narinfo removals.
  - `store_path_hash` (PK), `nar_hash`, `created_at`.
- `retention_root` — a named channel of kept store paths, optionally expiring.
  - `name` (PK), `expires_at` (nullable), `created_at`, `updated_at`.
- `retention_root_target` — the store paths a channel currently keeps.
  - (`root_name`, `store_path_hash`) (PK), `store_path`.
- `auth_key` — deployment-owned key material for cupboard access JWTs.
  - `id` (PK), `private_jwk_json`, `public_jwk_json`, `created_at`,
    `retired_at`.
- `oidc_trust` — generic OIDC trust rules for minting write-scoped JWTs (V4
  increment 2).
  - `id` (PK), `issuer`, `jwks_url` or discovery URL, `audience`, `scope`,
    `claims_json`, allowed root names or prefixes, `created_at`, `disabled_at`.

## Routes

Public reads and health/version endpoints are served by the Worker from R2 and
the Cache API where possible; the Durable Object handles auth, writes, admin,
and GC routes.

| Method    | Path                    | Auth             | Notes                                          |
| --------- | ----------------------- | ---------------- | ---------------------------------------------- |
| GET, HEAD | `/nix-cache-info`       | public           | Worker; `text/x-nix-cache-info`.               |
| GET, HEAD | `/<hash>.narinfo`       | public           | Worker, from the R2 object + edge cache.       |
| GET, HEAD | `/nar/<hash>.nar.zst`   | public           | Worker, from R2 + edge cache.                  |
| GET       | `/pubkey`               | public           | Worker, cached from the DO.                    |
| GET       | `/_health`              | public           | Worker. Liveness.                              |
| GET       | `/_version`             | public           | Worker. Git SHA, `+dirty` when dirty.          |
| POST      | `/auth/bootstrap`       | bootstrap secret | DO. Mints a short-lived admin cupboard JWT.    |
| GET       | `/stats`                | admin JWT        | DO. Cache size and object count.               |
| DELETE    | `/paths/<hash>`         | admin JWT        | DO. Deletes one store path; defers its NAR.    |
| GET       | `/roots`                | admin JWT        | DO. Lists retention roots.                     |
| PUT       | `/roots/<encoded-name>` | write JWT        | DO. Creates or replaces a retention root.      |
| DELETE    | `/roots/<encoded-name>` | admin JWT        | DO. Removes a retention root.                  |
| POST      | `/uploads`              | write JWT        | DO. Returns skip, commit, or upload plans.     |
| PUT       | `/uploads/<id>`         | write JWT        | DO. Returns R2 PUT URL and headers.            |
| PUT       | (presigned R2 URL)      | URL              | Client uploads blob directly to R2.            |
| POST      | `/uploads/<id>/commit`  | write JWT        | DO. Writes the narinfo row and R2 object.      |
| POST      | `/gc`                   | admin JWT        | DO. Runs pending-upload, retention, and R2 GC. |
| POST      | `/auth/oidc/exchange`   | OIDC token       | DO. V4 increment 2: exchanges CI identity.     |

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
      `/pubkey`) from the Worker. `/pubkey` reads the active key from the DO
      once and caches it. This assumes a stable signing key; key rotation is a
      V3 concern, so revisit Worker-side pubkey caching when rotation lands
      rather than leaving hidden staleness to unwind later.
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

- [ ] Support private-read mode via HTTP basic auth, consumed by Nix through
      `~/.config/nix/netrc`.

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

- [ ] Support one or more named cache paths for organisation:
  - [ ] `/cache/:cacheName/nix-cache-info`
  - [ ] `/cache/:cacheName/<hash>.narinfo`
  - [ ] `/cache/:cacheName/nar/<hash>.<ext>`
  - [ ] `/cache/:cacheName/pubkey`

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
  - Registry: caches are implicit — a `cache` row (name, priority) is created on
    first push or root with `--cache <name>`. The default cache is the empty
    name with the current priority.
  - Reachability GC and retention roots are scoped per cache.
  - CLI: `--cache <name>` on `push`, `config`, `root`, and `delete`.
  - One deployment-wide signing key, shared by all caches (each
    `/cache/:cacheName/pubkey` returns it). Per-cache keys would add rotation
    and config complexity with no clear personal-cache benefit.

### Signing

- [ ] Support rotation: generate a new keypair, keep old narinfos verifiable,
      and make the migration path explicit for users with pinned
      `trusted-public-keys`.
  - [ ] Invalidate the Worker-side `/pubkey` cache when the key rotates.
        `read.ts` caches the active key assuming it is stable (see V2 Worker
        read routing), so rotation must clear or version that cache rather than
        leave stale key bytes served from the edge.

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

- [ ] Multi-signing during a rotation window is **mandatory**, not conditional.
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
- [ ] Optional retention period for cold paths. Design: "cold" = a path held
      only by an implicit `pin:<storePathHash>` root (a plain push), never named
      by an explicit root. Implicit pins are permanent today; add an optional
      deployment default TTL applied to newly created implicit pins, so casually
      pushed paths expire if not refreshed or explicitly rooted. Unset keeps the
      current permanent behaviour; explicit roots are unaffected (they carry
      their own TTL). This is the simplest case of the policies below.
- [ ] Retention policies per cache or name prefix. Design: a `retention_policy`
      set (scope `cache` or `root-name prefix`, a glob/pattern, a default TTL).
      When a root is created without an explicit TTL, the most specific matching
      policy supplies one (e.g. `pr-*` → 14 days). The per-prefix half works on
      roots today; the per-cache half depends on named caches (Read path). Admin
      commands list/add/remove policies.
- [ ] Repair/check command to compare metadata against R2. Design: an
      admin-scoped `GET /check` route and `cupboard check` CLI command scan the
      committed `narInfos`/`narBlobs`, confirm each referenced R2 object exists
      and (with `--deep`) that its SHA-256 matches the recorded `fileHash`, and
      report discrepancies. Check-only first; repair actions (clear rows whose
      blob vanished, re-materialise a missing narinfo object) reuse the
      removal/ensure paths and land as a follow-up. This is the on-demand
      counterpart to the background verification below.
- [ ] Queue-based background verification. Design: the scheduled counterpart to
      repair/check — periodically reconcile committed metadata against R2 and
      perform the "orphan reconcile" deferred from V2 (re-materialise a missing
      narinfo object; schedule deletion for a row whose NAR has vanished, via
      the existing durable queue and grace). Start cron-driven with a bounded
      cursor in DO SQLite scanning a fixed batch per run (no new binding); move
      to Cloudflare Queues only if the scan cannot stay within cron/DO limits.
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

- [ ] Concurrent-write coverage: racing commits and negotiations on the same
      store path hash and NAR hash resolve to one committed row and consistent
      blob accounting (deferred from V1 Storage).
- [ ] Durable Object eviction and durability coverage: DO SQLite state — the
      signing key and committed metadata — survives eviction and
      re-instantiation, not just repeated in-process requests (deferred from V1
      Storage and Signing).

## V4

V4 replaces the V1 opaque bearer-token model with short-lived cupboard-issued
JWT access tokens and CI identity federation. The goal is to make CI writes work
without long-lived repository secrets while keeping upload and admin handlers on
one validation path.

### Authentication and CI federation

Cupboard should avoid long-lived CI secrets. CI systems that can prove where a
job came from should exchange that proof for a short-lived cupboard access JWT
instead of storing a write token as a repository secret.

The server should build its own small exchange endpoint rather than adopting a
full auth framework or OAuth server. The exchange is cupboard-specific: verify
an upstream identity token, match it against configured trust rules, and mint a
cupboard access JWT. Use a JOSE/JWT library such as `jose` for signature, JWKS,
issuer, audience, expiry, and algorithm validation; do not hand-roll JWT
cryptography.

- [x] Replace opaque stored bearer tokens on upload/admin handlers with
      cupboard-issued JWT access tokens. Handlers validate one credential type:
      `Authorization: Bearer <cupboard-jwt>`.
- [x] Sign cupboard access JWTs with a deployment-owned key stored in DO SQLite
      as `auth_key`. Bootstrap-admin JWTs include the base claims `iss`, `aud`,
      `sub`, `iat`, `nbf`, `exp`, `jti`, and `scope`. OIDC-minted write JWTs may
      additionally include provider-origin audit claims, such as CI provider,
      repository ID, workflow ref, run ID, run attempt, ref, and SHA.
- [x] Keep access JWTs short-lived and stateless. Do not store each issued JWT
      in the database; rely on expiry and signing-key rotation rather than a
      token table for normal operation.
- [ ] Keep long-lived secrets out of normal request handlers. The bootstrap
      secret is accepted only by `/auth/bootstrap`, which mints a short-lived
      admin JWT. External CI OIDC tokens are accepted only by
      `/auth/oidc/exchange`, which mints a short-lived write JWT.
- [x] Add the `auth_key` table holding the active JWT signing key, with `id`,
      `private_jwk_json`, `public_jwk_json`, `created_at`, and `retired_at` (the
      latter reserved for future key rotation).
- [ ] Add generic `oidc_trust` rows for CI identity rules, with `id`, `issuer`,
      `jwks_url` or discovery URL, `audience`, `scope`, `claims_json`, allowed
      root names or prefixes, `created_at`, and `disabled_at`. `issuer` and
      `audience` are required checks; configured claims are exact-match policy
      data, so providers are data rather than hardcoded branches.
- [x] Add the `/auth/bootstrap` DO route. It is the only route that accepts the
      long-lived bootstrap secret.
- [ ] Add the `/auth/oidc/exchange` DO route. It is the only route that accepts
      external OIDC tokens.
- [ ] Add a generic OIDC exchange backed by `oidc_trust`, with required `issuer`
      and `audience` checks and configurable exact-match claims. Treat GitHub
      Actions as the first documented fixture and CLI convenience path, not a
      hardcoded provider. The same trust-rule evaluator should also fit Cognito,
      Google Workload Identity Federation, and other OIDC issuers that provide
      signed tokens with stable claims.
- [ ] Store trust rules in `oidc_trust`. Prefer stable ID claims when a provider
      has them, such as GitHub `repository_id` and `repository_owner_id`; keep
      names like `repository` and `workflow_ref` for readability and optional
      narrowing. Support claim-exact matches first, with pattern matching only
      if a concrete use case needs it.
- [ ] Bind write-scoped JWTs to the roots they may update. A trust rule should
      produce either an allowed root set or a root-name prefix/namespace, so a
      CI token for one repository cannot replace another repository's retention
      root.
- [ ] Add CLI support for CI exchange. In GitHub Actions, request an OIDC token
      with `id-token: write`, pass cupboard's configured audience, exchange it,
      and use the returned cupboard JWT for the existing push flow.
- [ ] Add admin commands to list, add, disable, and inspect OIDC trust rules.
- [x] Remove the legacy `token` table and V1 opaque-token init flow once the
      bootstrap exchange and admin JWTs cover the write and admin routes.
- [ ] Tests:
  - [x] Unit: JWT verification rejects wrong issuer, audience, algorithm,
        expiry, not-before, missing scope, and malformed claims.
  - [ ] Unit: trust-rule matching accepts only the configured issuer, audience,
        and claim set; include GitHub Actions as one fixture, not a special
        provider branch.
  - [x] Integration: `/auth/bootstrap` returns an admin JWT and upload/admin
        handlers accept only the required scope.
  - [ ] Integration: `/auth/oidc/exchange` accepts a signed OIDC JWT whose
        issuer, audience, and claims match a trust rule and rejects unknown or
        mismatched issuers, audiences, and claims. Include a GitHub-shaped token
        as one fixture.
  - [ ] E2E: CI-style push obtains a cupboard JWT by exchange and performs the
        normal negotiate, prepare, and commit flow without any stored cupboard
        secret.

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

## Later features

- [ ] Chunk-level dedupe rather than whole-NAR storage.
- [ ] Import from an existing binary cache.
- [ ] Web dashboard.
- [ ] S3-compatible migration/export tooling.
- [ ] `watch-store` mode in the CLI.
