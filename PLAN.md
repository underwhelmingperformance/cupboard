# `cupboard` Plan

A Cloudflare Workers substituter for Nix.

## Non-Goals

- Multi-tenant hosting. One personal deployment per Worker; named caches inside
  it are for organisation only.
- Federation, mirroring, or peer-to-peer between deployments.
- Replacing Hydra, Cachix, or Attic at organisational scale.
- Acting as a general HTTP file host. Only Nix store paths and their metadata.

## Compatibility

- Target Nix 2.34 (latest at time of writing). Older clients are not a v1
  concern; revisit if real users turn up on earlier versions.
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
- [x] Authenticate write and admin operations with one deploy-time secret or
      token.
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

- [x] Configure against a personal Worker URL and write token.
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

- [x] Initialise deployment: mint the write token and generate the signing key.
- [x] Print Nix substituter config for the user's `nix.conf`.
- [x] Show the public signing key.
- [x] Inspect cache stats.
- [ ] Tests:
  - [ ] Unit: substituter config command renders a correct `nix.conf` snippet
        for a given Worker URL and pubkey.
  - [x] Integration: init mints exactly one write token and one signing key,
        idempotently; stats returns accurate row counts.

### Test harness

- [ ] Shared Vitest setup at workspace root for Tier 1.
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
- [ ] Tests:
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
  - `r2_key` (PK), `created_at`.
- `token` — write and admin tokens.
  - `id` (PK), `hash`, `scope`, `created_at`.

## Routes

| Method    | Path                   | Auth   | Notes                                   |
| --------- | ---------------------- | ------ | --------------------------------------- |
| GET, HEAD | `/nix-cache-info`      | public | `text/x-nix-cache-info`.                |
| GET, HEAD | `/<hash>.narinfo`      | public | `text/x-nix-narinfo`.                   |
| GET, HEAD | `/nar/<hash>.nar.zst`  | public | Compressed NAR blob.                    |
| GET       | `/pubkey`              | public | Active public key.                      |
| POST      | `/upload/negotiate`    | write  | Returns skip, commit, or upload plans.  |
| POST      | `/upload/<id>/prepare` | write  | Returns R2 PUT URL and headers.         |
| PUT       | (presigned R2 URL)     | URL    | Client uploads blob directly to R2.     |
| POST      | `/upload/<id>/commit`  | write  | Server writes the narinfo.              |
| GET       | `/_health`             | public | Liveness.                               |
| GET       | `/_version`            | public | Git SHA, with `+dirty` when applicable. |
| GET       | `/_stats`              | admin  | Cache size and object count.            |

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
installs Nix.

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
hash always maps to the same narinfo. Deletion is therefore the only mutation
the cache has to handle, which is what the TTL-ordered GC below addresses.

### Worker read routing

- [x] Add `packages/server/src/read.ts` owning the read routes. `handler.ts`
      tries it first and forwards everything else to the DO stub. Thread `ctx`
      into the Worker `fetch` so cache writes can use `ctx.waitUntil`.
- [ ] Move `parseNarName`, `parseNarInfoName`, and the conditional-request
      helper (`isNotModified`) out of `do.ts` into a place `read.ts` can share.
- [ ] Remove the `/nar/:narName` and `/:narInfoName` routes, and the
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
- [ ] The narinfo DB row is the source of truth; the `narinfo/<storePathHash>`
      R2 object is a materialised, regenerable cache of it. The row carries
      every field including the signature, and rendering is deterministic, so
      re-materialising is byte-identical. Reads serve the object; truth and
      queryability stay in the row.
- [ ] Never advertise a path as present without a servable object, but do not
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
- [ ] Serve `GET` `/<storePathHash>.narinfo` in the Worker from R2 via
      `caches.default`, with ETag, last-modified, and 304 driven by the R2
      object; `HEAD` from `BLOBS.head` without caching.
- [ ] Stop reading the narinfo row on the read path; it remains only for GC and
      stats.
- [ ] Tests:
  - [ ] Integration: commit writes the R2 object; the Worker serves it and the
        signature verifies against the published pubkey; 404 before commit;
        conditional GETs return 304.
  - [x] Integration: when the R2 object already exists, a second commit for an
        existing `storePathHash` returns `already-present` and leaves both the
        DB row and the R2 object byte-for-byte unchanged. The missing-object
        case is covered by the failure-recovery test below.
  - [ ] Integration: after an R2 narinfo write failure the committed row
        remains, and a later negotiate or commit retry re-materialises the
        missing object from the row; concurrent commits for one `storePathHash`
        do not overwrite an existing narinfo object.

### TTL-ordered garbage collection

narinfo responses are edge-cached with a max-age, and `caches.default.delete`
only purges the current colo. A deleted narinfo can therefore still be served
from a warm edge for up to its TTL. To stop a cached narinfo pointing at a
deleted NAR, NAR deletion is deferred until any edge-cached narinfo for it has
expired.

- [ ] Define one narinfo cache TTL constant and derive the GC grace from it
      (`grace = ttl + margin`). The narinfo `Cache-Control` max-age and the
      grace come from the same source so they cannot drift apart.
- [ ] On narinfo removal — the negotiate stale-recovery path at `clearNarInfo`,
      and future reference-graph GC — delete the DB row first, then the
      `narinfo/<storePathHash>` R2 object, best-effort `caches.default.delete`
      in the current colo, and enqueue the NAR blob for deletion no earlier than
      `now + grace`, only if no other narinfo references that NAR hash.
      Row-first ordering means an interrupted removal leaves only an orphan
      object with no row, never a row with no object, mirroring the row-first
      commit path.
- [ ] Reconcile orphan narinfo objects. The reconcile is origin-agnostic: it
      keys off the observable "a `narinfo/<storePathHash>` object exists with no
      committed row" and deletes the object, whatever produced it. Under
      row-first commit and row-first removal the one expected source is an
      interrupted removal; keying off the observable rather than the cause also
      makes this a backstop if commit ordering is ever violated and an object is
      left without a row. Because such an object may have been edge-cached while
      it was live, deleting it enqueues its NAR under the same `now + grace`
      delayed rule rather than deleting the NAR immediately, unless the
      interrupted removal already enqueued it. Abandoned-pending GC can trigger
      this cheaply using the `storePathHash` in the pending row's
      `metadata_json`; a broader sweep over narinfo objects stays a V3 concern.
- [ ] Extend the orphan-deletion queue with a `not_before` timestamp. The flush
      deletes a blob only when `now >= not_before` and the existing committed
      and live-pending reference checks still pass. Abandoned pending-upload
      enqueues set `not_before = now` for immediate deletion as today.
- [ ] `not_before` is monotonic non-decreasing. Because `r2_key` is the primary
      key, an enqueue that conflicts with an existing row must set
      `not_before = max(existing, new)`, never earlier. A blob delayed because
      an edge-cached narinfo may still reference it must not be pulled forward
      by a later immediate enqueue; neither plain `onConflictDoNothing` nor an
      overwrite is correct here, so the conflict must take the later timestamp
      explicitly. This is the part to implement most deliberately.
- [ ] Generate the Drizzle migration for the schema change.
- [ ] Selecting which committed paths to delete (retention roots, reachability)
      stays a V3 concern; this phase provides only the edge-safe deletion
      mechanism.
- [ ] Tests:
  - [ ] Integration: removing a narinfo deletes its R2 object and DB row; its
        NAR is retained until the grace elapses and then deleted by a later GC
        pass; a NAR still referenced by another narinfo is never deleted.
  - [ ] Integration: a delayed (`now + grace`) deletion is not pulled forward by
        a subsequent immediate enqueue for the same `r2_key`; the later
        timestamp wins and the blob survives until the grace elapses.
  - [ ] Integration: an orphan narinfo object with no committed row is deleted
        by GC, and its NAR is enqueued under the delayed rule rather than
        removed immediately.

### Data model and routes

- [ ] When this lands, update the Data Model `orphan_blob_deletion` entry for
      the new `not_before` column, and the Routes table to show narinfo and NAR
      served by the Worker rather than the DO.

## V3

V3 collects improvements that are useful, but not necessary to prove the core
cache.

### Compatibility

- [ ] Investigate whether any useful `nix copy --to https://...` compatibility
      can be supported. Keep the native CLI upload flow as the reliable path
      unless Nix exposes an HTTP write protocol that fits Workers and R2.
- [ ] Revisit support for older Nix clients if real users need it.

### Read path

- [ ] Support private-read mode via HTTP basic auth, consumed by Nix through
      `~/.config/nix/netrc`.
- [ ] Support one or more named cache paths for organisation:
  - [ ] `/:cache/nix-cache-info`
  - [ ] `/:cache/<hash>.narinfo`
  - [ ] `/:cache/nar/<hash>.<ext>`
  - [ ] `/:cache/pubkey`

### Signing

- [ ] Support rotation: generate a new keypair, keep old narinfos verifiable,
      and make the migration path explicit for users with pinned
      `trusted-public-keys`.
- [ ] Support multiple active signatures during a rotation window if Nix client
      behaviour requires it.

### Garbage collection and admin

Retention roots are the gating prerequisite for everything below: without them,
GC against committed narinfo rows would happily delete anything still reachable
through substitution, since the cache has no inherent concept of "in use".

- [ ] Define explicit retention roots before deleting committed store paths.
- [ ] Delete a store path or clear old entries.
- [ ] Optional retention period for cold paths.
- [ ] Retention policies per cache or name prefix.
- [ ] Repair/check command to compare metadata against R2.
- [ ] Queue-based background verification.

### Token model

- [ ] Add read/write/admin scopes.
- [ ] Support expiring tokens.
- [ ] Add token rotation and revocation.

### Later features

- [ ] Chunk-level dedupe rather than whole-NAR storage.
- [ ] Multiple named caches inside one deployment.
- [ ] Import from an existing binary cache.
- [ ] Web dashboard.
- [ ] S3-compatible migration/export tooling.
- [ ] `watch-store` mode in the CLI.
