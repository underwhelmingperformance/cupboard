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

- [ ] Serve a valid Nix binary cache:
  - [ ] `/nix-cache-info`, carrying `StoreDir: /nix/store`, `WantMassQuery: 1`,
        and a `Priority`.
  - [ ] `/<hash>.narinfo` with an Ed25519 signature over the standard
        fingerprint `1;StorePath;NarHash;NarSize;Refs...`.
  - [ ] `/nar/<narHash>.nar.zst` for the compressed NAR blob.
- [ ] Support `GET` and `HEAD` for cache-info, narinfo, and NAR blob routes.
- [ ] Emit `References:` as space-separated basenames, not full store paths.
- [ ] Allow public unauthenticated reads, since Nix substituters usually need
      simple HTTP access.
- [ ] Tests:
  - [x] Unit: `nix-cache-info` serialiser; narinfo serialiser and parser
        round-trip; fingerprint construction; generated valid narinfo
        round-trips with `fast-check`.
  - [x] Unit: `fast-check` parser permissiveness properties for field order,
        optional fields, and blank lines.
  - [ ] Integration: GET each route returns the expected body and headers; HEAD
        returns the same headers with no body. Unknown hash returns 404 and a
        signed narinfo verifies against the published pubkey.

### Write path

- [ ] Push store paths from a companion CLI.
- [ ] Compress NARs with zstd by default at upload time, and record
      `Compression`, `FileHash`, and `FileSize` for the compressed blob
      alongside the uncompressed `NarHash` and `NarSize`.
- [ ] Authenticate write and admin operations with one deploy-time secret or
      token.
- [x] Validate uploaded NAR metadata:
  - [x] required: store path hash, NAR hash, NAR size, references
  - [x] optional: deriver and CA fields
- [ ] Upload large NARs directly to R2 via Worker-generated R2 S3 presigned PUT
      URLs. Streaming bodies through the Worker request is not an option given
      Workers' body-size and CPU limits; this is a hard requirement, not a
      "where possible".
- [ ] Provide deterministic, resumable-ish upload behaviour:
  - [ ] client computes the uncompressed NAR hash and size
  - [ ] server tells the client which blobs are missing
  - [ ] client uploads missing content directly to R2 with an R2-validated
        SHA-256 checksum header
  - [ ] server commits metadata once R2 confirms the blob is present
- [ ] Tests:
  - [x] Unit: NAR metadata validation (hash, size, references); rejecting
        narinfos missing required fields; recording compressed-blob metadata
        alongside uncompressed.
  - [ ] Integration: full upload flow (negotiate, presigned PUT, commit)
        produces a fetchable narinfo; re-uploading an already-present path is a
        no-op; the pending row is created on negotiate and cleared on commit;
        commit rejects missing or mismatched R2 SHA-256 checksums.

### Client

- [ ] Configure against a personal Worker URL and write token.
- [ ] Compute NAR hash and size locally while streaming the same NAR into zstd,
      so each path is read once.
- [ ] Upload only missing blobs.
- [ ] Show progress through a `Reporter` abstraction with two renderers,
      auto-selected from `stderr.isTTY`:
  - [ ] Terminal: `ora` spinners, `picocolors` for ANSI, `cli-table3` for result
        blocks. One phase per logical step (resolve closure, negotiate, prepare
        missing NARs, upload, commit), each collapsing to one line on completion
        with inline facts.
  - [ ] JSON: line-delimited events for CI logs and piping to `jq`. Event types
        are `phase`, `result`, `warn`, and `info`; phase events carry `status`,
        `durationMs`, and a `facts` object.
- [ ] `--colour` / `--no-colour` flags override the TTY auto-detection.
- [ ] Print Nix configuration:
  - [ ] `substituters = ...`
  - [ ] `trusted-public-keys = ...`
- [ ] Tests:
  - [ ] Unit: locally-computed NAR hash and size match what `nix-store --dump`
        produces (run against fixture paths); substituter config rendering.
  - [ ] E2E: push a fixture, configure a clean tmp Nix store with the
        substituter URL and public key, substitute the path back, assert the
        signature verifies. This is the Tier 3 golden-path scenario.

### Storage

- [ ] Store metadata in one Durable Object SQLite database.
- [ ] Store binary content in R2, keyed by the uncompressed NAR hash. A metadata
      row maps `narHash` to the actual stored blob path (for example
      `nar/<narHash>.zst`).
- [ ] One cache, served at the Worker root; named caches are a V2 concern.
- [ ] Tests:
  - [ ] Integration: schema initialises on first request; metadata-to-blob
        mapping survives committed reads and blob reuse. Concurrent writes and
        explicit DO eviction coverage are V2 hardening.

### Signing

- [ ] Generate the Ed25519 signing keypair during initialisation and persist the
      private key in a DO row, not a Workers secret, so it survives redeploys.
- [ ] Expose the public key via the admin command and an unauthenticated
      `GET /pubkey` route.
- [ ] Tests:
  - [ ] Unit: signature verification round-trip; key generation produces a valid
        Ed25519 keypair.
  - [ ] Unit: signature matches a known fixture for a fixed key and standard Nix
        fingerprint.
  - [ ] Integration: `GET /pubkey` returns the active key; first-request key
        generation persists across repeated requests. Explicit DO eviction
        coverage is V2 hardening.

### Garbage collection

- [ ] Use Cron Triggers for the GC pass. DO alarms are reserved for per-cache
      work that needs the DO's state mid-run.
- [ ] Clean abandoned pending uploads after a grace window.
- [ ] Delete abandoned pending-upload blobs that have no committed narinfo rows.
- [ ] Tests:
  - [ ] Integration: `pending_upload` rows past the grace window are cleared;
        orphaned R2 blobs for expired pending uploads are deleted; committed
        blobs are retained.
  - [ ] Integration: the cron trigger invokes the scheduled handler with the
        correct env. Committed blob deletion waits for retention roots.

### Admin

- [ ] Initialise deployment: mint the write token and generate the signing key.
- [ ] Print Nix substituter config for the user's `nix.conf`.
- [ ] Show the public signing key.
- [ ] Inspect cache stats.
- [ ] Tests:
  - [ ] Unit: substituter config command renders a correct `nix.conf` snippet
        for a given Worker URL and pubkey.
  - [ ] Integration: init mints exactly one write token and one signing key,
        idempotently; stats returns accurate row counts.

### Test harness

- [ ] Shared Vitest setup at workspace root for Tier 1.
- [ ] `@cloudflare/vitest-pool-workers` configured in `packages/server` for Tier
      2, picking up `*.workers.test.ts` only so the unit run is not slowed by
      Worker boot.
- [x] `fast-check` added as a dev dependency for property tests.
- [ ] Fixture generation script that runs `nix-store --dump` against a small set
      of synthetic store paths; outputs committed under `tests/fixtures/`.
- [ ] E2E harness under `tests/e2e/`: clean-env Miniflare Worker runner, local
      HTTP server for Nix, scoped `nix` invocation builder, and localhost URL
      validation. Enforces the Isolation invariants documented in the Testing
      section.
- [ ] `pnpm test:e2e` script wired at the root.

## Infrastructure

Cross-cutting concerns not tied to a single V1 sub-section. Bindings, cron, and
operational endpoints live with the features that use them.

- [ ] Wrangler-based deployment.
- [ ] Cache-friendly read responses:
  - [ ] stable URLs
  - [ ] ETag
  - [ ] `Cache-Control`
  - [ ] conditional request support if cheap
- [ ] Tests:
  - [ ] Integration: `ETag` and `Cache-Control` present on narinfo and NAR
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

- [ ] All child processes (`nix`, `nix-store`, and fixture helpers) spawn with
      an explicitly constructed env containing only `PATH`, a per-test temporary
      `HOME`, and variables the test sets deliberately. The parent `process.env`
      is not inherited.
- [ ] The Worker runs in local Miniflare, fronted by a test-owned HTTP server.
      There is no code path from a test to a real deployment.
- [ ] `nix` invocations get `--store local?root=<tmpdir>`,
      `NIX_USER_CONF_FILES=/dev/null`, and `NIX_CONF_DIR=<tmpdir>/etc` so they
      cannot read or write the developer's `/nix/store` or pick up their
      substituter config.
- [ ] Cupboard URLs are produced by the local test server and rejected unless
      the host is `127.0.0.1` or `localhost`.

### Fixtures

- [ ] Generate a small synthetic store path once with `nix-store --dump`. Commit
      it as a binary fixture under `tests/fixtures/`.
- [ ] Unit tests parse them; integration and E2E tests push and re-fetch them.

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

V2 collects improvements that are useful, but not necessary to prove the core
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
