# Architecture

This page explains how cupboard is built. It starts with the big picture, then
describes each Cloudflare resource and what it stores, then follows the main
requests through the system. The last sections cover keys, how tenants are kept
apart, and how upgrades work.

It's written for contributors and for anyone reviewing the design.
[PLAN.md](../../PLAN.md) records how the design came about. This page describes
what the code does now.

## The big picture

cupboard is a Nix binary cache. Nix downloads store paths from it, and the
`cupboard` CLI and CI jobs upload store paths to it. One deployment serves many
tenants, and each tenant has its own caches, keys and access rules.

A deployment runs entirely on Cloudflare. If you haven't used Cloudflare's
platform before, these are the pieces that cupboard uses:

- A **Worker** is a script that handles HTTP requests. It keeps no state between
  requests.
- A **Durable Object** is a single instance of a class, with its own private
  SQLite database. Each object has a name, and every request for that name goes
  to the same instance. cupboard uses one object per tenant.
- **D1** is a SQL database that every Worker in the deployment can share.
- **R2** is object storage, like S3. cupboard keeps NAR files and other large
  blobs there.
- **KV** is a key-value store. Reads are fast, but updates can take a while to
  reach every location.
- A **queue** keeps jobs for a Worker to process later, with retries.

A deployment has two Workers, one Durable Object class, one D1 database, one R2
bucket, two KV namespaces, and a queue with a dead-letter queue. The diagram
shows how they connect:

```text
                  Nix clients, cupboard CLI, CI jobs
                                 |
                                 v
 +--------------------- control Worker (`cupboard`) ---------------------+
 |  bare host: /control/* (oRPC), /token, /signup, JWKS, health         |
 |  /t/<tenant>/...: admission, private-read auth, write gate, dispatch |
 |  cron: hourly, enqueues maintenance   queue consumer: runs it         |
 +----+-------------+---------------+------------------+----------------+
      |             |               |                  |
      | service     | Durable       | D1, R2, KV       | Queue
      | binding     | Object RPC    |                  |
      v             v               v                  v
 +----------------------------+  +---------+  +------------------------+
 | tenant Worker              |  | D1      |  | cupboard-maintenance   |
 | (`cupboard-tenant`)        |  | R2      |  | (DLQ: -maintenance-dlq)|
 |  CachedTenantReads:        |  | KV x2   |  +------------------------+
 |   public reads via         |  +---------+             ^
 |   Workers Cache            |       ^                  | tenant-verify
 |  CupboardServer DO,        |-------+------------------+
 |   one per tenant, SQLite   |
 +----------------------------+
```

Every request arrives at the **control Worker**. Requests to the deployment
itself, such as the operator's admin API, are handled there. Requests under a
tenant URL, `/t/<tenant>/...`, are checked by the control Worker and then either
answered directly or passed on to that tenant's Durable Object.

The **tenant Worker** is a separate script that contains the Durable Object
class. It can't be reached from the internet. The next section explains why it's
separate.

Here's how the work is shared out:

- NAR and narinfo downloads are served straight from R2, by the control Worker
  or by the tenant Worker's `CachedTenantReads` entrypoint. They don't wake the
  tenant's Durable Object.
- Pushes, admin requests and token exchanges go to the tenant's Durable Object,
  which owns everything specific to one tenant. The NAR bytes in a push are the
  exception. The CLI uploads them straight to R2.
- Facts shared between tenants, or needed by the control Worker, are in D1.
- Background work, such as garbage collection and checking uploaded bytes, runs
  from the queue.

## The two Workers

### The control Worker

The control Worker is called `cupboard`, and its configuration is
`packages/server/wrangler.jsonc`. It's the only public entry point. It handles
three kinds of work.

On the **bare host**, meaning the deployment URL with no tenant in the path, it
serves the control surface:

- the control-plane admin API, under `/control/`;
- the control token endpoint, `POST /token`;
- the first-operator claim, `POST /signup`;
- the control plane's JWKS and OAuth metadata;
- the health and version endpoints, `/healthz`, `/_health` and `/_version`.

Under a **tenant URL**, `/t/<tenant>/...`, it's the tenant's front door. It
checks that the tenant exists (this is called admission), authenticates reads
from private caches, and makes the final decision on whether a write is allowed.
It then passes the request on to the tenant's Durable Object when needed.

It also runs the **scheduled work**: the hourly cron trigger, and the consumer
for the maintenance queue.

### The tenant Worker

The tenant Worker is called `cupboard-tenant`, and its configuration is
`wrangler.tenant.jsonc`. It defines the `CupboardServer` Durable Object class,
and a second entrypoint called `CachedTenantReads`, which serves public reads.

It has no `workers.dev` route and no preview URLs. Its default `fetch`
entrypoint answers every request with 404. The control Worker reaches it in two
ways only:

- through a service binding, `CUPBOARD_TENANT`, to call `CachedTenantReads`;
- through an external Durable Object binding, `CUPBOARD_DO`, with
  `script_name = "cupboard-tenant"`, to call a tenant's object.

### Why there are two Workers

The split keeps the control plane's signing key away from tenant code.

Within a single Worker script, every binding is visible to every Durable Object
class that the script defines, and that includes secrets. A D1 binding also
gives access to the whole database, not just some tables.

The control plane's signing key is stored in D1, wrapped (encrypted) with a
secret called `CONTROL_KEY_WRAP_SECRET`. If the Durable Object lived in the
control Worker's script, it could read both the wrapped key and the secret. In
its own script, it never binds `CONTROL_KEY_WRAP_SECRET`. It can still read the
D1 row that contains the wrapped key, but it can't unwrap the key.

## The tenant Durable Object

Each tenant has one `CupboardServer` object. The control Worker finds it with
`idFromName(<slug>)`, where the slug is the tenant's name in its URL, such as
`acme`. The object uses SQLite-backed Durable Object storage.

The object owns everything that belongs to one tenant alone. That includes:

- the tenant's identity, in the `tenant_identity` table: its slug, issuer,
  audience, owner, and a configuration version that only ever goes up;
- its caches, in `cache_identity`;
- its committed narinfos, each with a generation counter per store path;
- pending uploads, and the result of verifying each one;
- retention roots, what they point at, grace deadlines, and the state of garbage
  collection;
- the keys that it signs narinfos with, in `signing_key`, and the keys that it
  signs access tokens with, in `auth_key`;
- OIDC trust rules, refresh-token families, and reuse views.

The object also runs the tenant's HTTP app, in `do/server.ts`. The app serves:

- the tenant's oRPC admin procedures;
- the tenant token endpoint;
- the commit WebSocket that the CLI uses during a push.

Background work for the tenant runs from the object's alarm.

The object's schema migrations live in `packages/server/drizzle`. The object
applies them to its own database.

## Storage

### D1

D1 stores the state that spans tenants, and the state that the control Worker
needs to read. The control Worker keeps no state of its own, so every decision
that it makes has to be based on D1 or KV. The binding is `CUPBOARD_DB`, and the
migrations are in `packages/server/drizzle-d1`.

| Table                                                          | What it stores                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `tenant`                                                       | The list of tenants: status, owner identity, config version, the fallback read-credential verifier, and maintenance position. |
| `tenant_cache_read_credential`                                 | The verifier for each cache that has its own read credential.                                                                 |
| `cache_lifecycle`                                              | Each cache's access mode, generation, read revision and deletion time.                                                        |
| `blob_state`                                                   | The set of verified NARs, shared by all tenants: hashes, sizes, compression, and the deadline for reaping.                    |
| `blob_ref`                                                     | One reference for each committed narinfo version, from a tenant's cache to a NAR hash. These references authorise NAR reads.  |
| `tenant_blob`, `tenant_cas_blob`                               | Which NARs and attestation bundles each tenant uses, for counting storage.                                                    |
| `tenant_usage`                                                 | Each tenant's usage counters and quota. A `CHECK` constraint refuses a charge that would go over the quota.                   |
| `cas_object`, `attestation_ref`                                | Stored attestation bundles and their references.                                                                              |
| `object_incarnation`, `object_deletion`                        | Bookkeeping for versions of R2 objects, and scheduled deletions.                                                              |
| `control_auth_key`, `control_trust`, `global_admin`            | The control plane's signing keys (with the private part wrapped), its trust rules, and the first operator.                    |
| `deployment_phase`, `local_step_wake_cursor`                   | Progress through a staged deployment.                                                                                         |
| `tenant_maintenance_failure`, `tenant_maintenance_eligibility` | The results of maintenance runs, and hints about which tenants to wake.                                                       |
| `instance_config`                                              | The deployment's instance name.                                                                                               |

Some of these tables are written by only one party. A tenant's Durable Object is
the only thing that writes that tenant's `blob_ref` and `tenant_blob` rows.
`blob_state` is shared. Any tenant's object writes to it when it promotes
verified bytes, and the control Worker's reapers write to it when they delete
objects.

### R2

cupboard stores every object in one bucket, `cupboard-blobs`, bound as `BLOBS`.
The key tells you what an object is:

| Key                                                         | What's stored there                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `nar/<narHash>.nar.zst`                                     | Verified NARs, compressed with zstd. They're shared between tenants.                    |
| `nar/<narHash>.<n>.nar.zst`                                 | A later copy (incarnation) of the same NAR, written after an earlier one was deleted.   |
| `staging/<pushId>/<uploadId>.nar.zst`                       | Uploads that haven't been verified yet. This is the only place where clients can write. |
| `staging/<pushId>/attestations/<uploadId>`                  | Attestation bundles that haven't been verified yet.                                     |
| `cas/<sha256>[.<n>]`                                        | Attestation bundles, stored by the hash of their content and shared.                    |
| `t/<tenant>/narinfo/[generation/<g>/][<cache>/]<hash>`      | Signed narinfos, ready to serve, one for each tenant and cache.                         |
| `t/<tenant>/attestations/[generation/<g>/][<cache>/]<hash>` | The list of attestations for each store path.                                           |

The `generation/<g>/` part of a key only appears from a cache name's second
generation onwards. When you delete a cache, its generation goes up by one. A
new cache with the same name then uses different keys, so it can't read anything
left over from the old one.

Earlier releases stored private caches under a `private/` name. A migration in a
later release moved those objects to the current keys.

The deploy sets an R2 lifecycle rule on the `staging/` prefix. It deletes
anything there a day after it's written, and aborts multipart uploads there that
are still incomplete after a day.

### KV

There are two KV namespaces.

`TENANT_CACHE` records which tenants exist. Only the control Worker binds it. It
stores two things:

- a binary fuse filter of the slugs of live tenants, under the key
  `tenant-filter`;
- a marker for each tenant, under `tenant-member:<slug>`.

The filter and the markers let the control Worker turn away an unknown slug
before it creates a Durable Object for it. They can't admit a tenant, though.
The final decision always comes from reading D1. If KV fails, the control Worker
falls back to that D1 read rather than refusing the request.

`CRON_STATE` records where each reaper's demote scan should resume: the NAR
reaper's under `reaper:demote-cursor`, and the attestation reaper's under
`reaper:cas-demote-cursor`.

## Scheduled and background work

The control Worker's cron trigger fires every hour (`0 * * * *`). It first
refreshes the tenant membership in KV. It then adds jobs to the
`cupboard-maintenance` queue. Each job is small and bounded, so a failure only
retries that one message, not the whole hourly run.

These are the jobs that the cron trigger adds:

- `cache-catalogue-migration`, for up to 100 tenants whose cache catalogue
  hasn't been migrated yet.
- `tenant-maintenance`, for up to 100 active tenants that are due, oldest first.
  Each job runs the tenant's garbage collection, its verification pass, and the
  retirement of old access-token keys.
- `offboard`, for up to 10 tenants that are being removed. Each job deletes the
  tenant's rows and objects.
- `blob-reaper` and `cas-reaper`. These delete NAR and attestation objects that
  have had no references for a grace period.
- `blob-demote` and `cas-demote`. These look for shared objects that have gone
  missing.
- `control-key-retirement`, which retires control-plane keys that are due for
  retirement.
- `local-step-sweep`, which wakes up to 20 tenants that haven't yet reached the
  data-migration step that the deployed build needs. See
  [Deployments and upgrades](#deployments-and-upgrades).

A tenant's Durable Object can also add a job. When a commit leaves bytes waiting
to be verified, the object adds a `tenant-verify` job.

The control Worker consumes the queue one message at a time, with up to four
consumers running at once. A message that fails is retried after 60 seconds, up
to three times. After the third retry, it goes to the dead-letter queue,
`cupboard-maintenance-dlq`. cupboard doesn't read the dead-letter queue. The
next hourly run adds fresh jobs instead.

## How requests flow

### Reading a narinfo or a NAR

When Nix asks a cache for a narinfo or a NAR, the request goes through these
steps:

1. The control Worker parses `/t/<tenant>/[cache/<name>/]...` from the raw path.
   It refuses a tenant slug or cache name that's percent-encoded.
2. It checks that the tenant exists. First it checks the membership filter and
   the KV marker. Then it reads the tenant's row, and the addressed cache's
   lifecycle and read-credential verifier, from D1 in one batch. An unknown
   tenant gets a 404. So does a read from a tenant that isn't active. A read
   from a deleted cache gets a 404 after authentication.
3. If the cache is private, the control Worker checks the request's HTTP Basic
   credentials against a salted verifier. It uses the cache's own verifier if
   the cache has one, and the tenant's verifier otherwise. The control Worker
   then serves the read itself, with `Cache-Control: no-store`.
4. If the cache is public, the control Worker passes the read to
   `CachedTenantReads` through the service binding. The request includes the
   cache generation and read revision that admission found. `CachedTenantReads`
   serves the read through the Workers Cache, and tags each narinfo so that
   exactly that narinfo can be purged later.
5. A narinfo is the R2 object at the tenant's narinfo key. A public read needs
   no further D1 query. An authenticated read also checks the `blob_ref`
   reference in D1, so it can't serve an object from a different commit.
6. For a NAR, the Worker checks that there's a `blob_ref` reference from the
   addressed cache to that hash, at the cache's current generation and access
   mode. It then streams `nar/<hash>.nar.zst` from R2. If the cache doesn't
   refer to the NAR, the response is the same 404 as for a NAR that doesn't
   exist.

Public NARs are cached for a year, marked as immutable. Public narinfos are
cached for an hour, with `must-revalidate`.

Narinfo and NAR reads never wake the tenant's Durable Object. These reads do:
`nix-cache-info`, the public key, attestations, availability queries, and reuse
views.

### Pushing store paths

When you run `cupboard push`, the CLI and the server go through these steps. The
requests below are all under the tenant URL.

1. The CLI asks for an upload credential with `POST /uploads/credential`. The
   tenant's object returns two things:
   - a push ID, signed with HMAC using `PUSH_ID_SIGNING_KEY`, which is valid for
     24 hours;
   - a temporary R2 credential. The object creates this itself from the R2 API
     token, without calling Cloudflare.

   The credential only allows `PutObject` and the multipart-upload actions, and
   only under `staging/<pushId>/`. It can't read or list objects. It lasts at
   most six hours, and never longer than the CLI's access token.

2. The CLI asks what to upload by calling `POST /uploads` with the store path,
   NAR hash, NAR size and references of each path. The control Worker first
   reads shared facts from D1, as hints. The tenant's object then decides what
   happens to each path:
   - `skip`: the path is already committed in this cache.
   - `commit`: this tenant already refers to a verified NAR with that hash, so
     no bytes need uploading.
   - `upload`: the CLI must upload the NAR, and the response gives it a staging
     key.

3. The CLI compresses each NAR with zstd and uploads it straight to R2, using an
   S3 client. NAR bytes never pass through a Worker.

4. The CLI opens the commit WebSocket with `GET /commit`. This is a hibernatable
   socket on the tenant's object. The CLI commits uploads one at a time or in
   batches of up to 100. The server sends credit frames to control how fast the
   CLI can send. If a declared NAR size is over 4 GiB, the server refuses it
   with 413.

5. The object records the upload as pending, and adds a `tenant-verify` job to
   the queue. The queue consumer verifies the bytes. It claims a batch of up to
   32 uploads, totalling at most 4 GiB of declared NAR size, and streams each
   staged object through native zstd decompression and SHA-256. It compares the
   result with the NAR hash and size that the CLI declared. The same pass hashes
   and measures the compressed bytes. This means that the stored file hash and
   file size come from the server, not from the client.

6. If the bytes match, the object promotes them. It copies them to
   `nar/<narHash>.nar.zst`, and asks R2 to check the SHA-256 again and to write
   the object only if the key doesn't already exist. In one D1 batch, it then
   records the `blob_state` row, the `blob_ref` reference, and the charge to the
   tenant's usage. Finally it publishes the path: it writes the signed narinfo
   to R2, and sends the result to the CLI over the waiting WebSocket.

   If the bytes don't match, the object deletes the staged object and records a
   final `mismatch` result. If the charge would take the tenant over its quota,
   the result is `over-quota`.

7. The push decides how long the paths are kept. It can specify a retention root
   with `--root`, pin each path with its own `pin:<hash>` root, or publish into
   the cache's grace period with `--no-retain`. Garbage collection deletes
   anything that no root or grace period is keeping.

### Exchanging tokens

cupboard doesn't store passwords. Instead, a client signs in by exchanging an
OIDC ID token from an identity provider for a cupboard access token.

To get a tenant token, a client sends an ID token to `POST /t/<tenant>/token`.
This is an RFC 8693 token exchange. The tenant's object matches the token
against its trust rules, by issuer, audience, subject and claims. If a rule
matches, the object issues an access token: a JWT signed with EdDSA, whose
issuer is `https://<host>/t/<tenant>`. The token contains the rule's grants as
RFC 9396 `authorization_details`.

How long a token lasts depends on the rule that matched:

- A rule for interactive sign-in gives a token that lasts 10 minutes, and a
  refresh token. The refresh token's family expires after 30 days.
- A rule for CI gives a token that lasts 15 minutes, and no refresh token.

A client can also exchange a cupboard access token for one with fewer grants.

For a control token, `POST /token` on the bare host works the same way, but
matches against the control-plane trust rules in D1's `control_trust` table. It
issues a token that lasts 10 minutes, signed with the current control key.

`POST /signup` makes the first caller who passes the deployment's claim check
into the first operator. The check is either a claim secret, or a pinned issuer
and subject. In one D1 batch, it records the operator and creates the first
control trust rule. Anyone else who tries to claim the deployment afterwards is
refused.

The CLI gets ID tokens by signing in through the browser, using PKCE with a
loopback redirect, or through the device flow. By default it uses Cloudflare's
OIDC issuer. CI jobs use the OIDC token that their CI platform gives them.

## Keys and secrets

[Where keys and secrets are kept](../security.md#where-keys-and-secrets-are-kept)
lists every key and secret, and how each is protected. In the code:

- Control signing keys are Ed25519 keys in D1's `control_auth_key` table. Each
  private JWK is wrapped with AES-256-GCM under `CONTROL_KEY_WRAP_SECRET`.
- Each tenant's narinfo signing keys and access-token keys are plain JWKs in the
  tenant object's SQLite, in the `signing_key` and `auth_key` tables.
- Read credentials are stored in D1 as a user name, a salt and a salted SHA-256
  hash. The server generates each password from 32 random bytes.

Tenant administrators can rotate signing keys and access-token keys through the
admin API. When a signing key is rotated, the existing narinfos are re-signed in
bounded batches, and their cached copies are purged, before the rotation
completes.

## Keeping tenants apart

Each tenant is isolated from the others in these ways:

- A tenant's narinfos, keys, trust rules, roots and tokens all live in its own
  Durable Object.
- A tenant's tokens contain its own issuer and audience. Another tenant rejects
  them.
- If an object has no stored identity, it refuses to serve anything. It doesn't
  fall back to a default issuer.
- Each tenant signs narinfos with its own key. A Nix client that trusts one
  tenant doesn't trust another tenant's narinfos.

D1 and R2 are different. Every tenant's object binds the same database and the
same bucket, so the bindings don't keep tenants apart. The code does. Tenants
can't run code of their own.

### Deduplication, and what it could reveal

cupboard stores the bytes of each NAR once, under its NAR hash, however many
tenants publish it. This could let one tenant find out whether another tenant
has stored a particular NAR. cupboard is designed to avoid that:

- When the object decides between `commit` and `upload` during a push, it only
  looks at NARs that the pushing tenant already refers to. It never checks
  whether the NAR exists anywhere else. So a tenant that doesn't refer to a NAR
  is told to upload it, even if another tenant has already stored it.
- The upload is verified first. Only then is it matched to the existing copy.
- A NAR read is only allowed if the reading cache itself refers to the NAR.

One signal remains. After uploading, a NAR that already exists may become
available to download sooner than a new one would. This is documented rather
than hidden. A mode that makes every new reference wait the same length of time
is listed as a future feature.

## The admin API

The JSON admin APIs are contract-first. Every procedure is declared exactly
once, in `packages/protocol/src/contract`, with its method, path, input, output,
errors and the grant that it requires.

The server implements the contract with oRPC, in `packages/server/src/orpc`.
Control-plane procedures are served under `/control/` by the control Worker.
Tenant procedures are served by the tenant's Durable Object. The CLI builds its
clients from the same contract. Both sides validate responses at runtime.

All routing uses Hono:

- `routing/handler.ts` for the control Worker;
- `control/control-app.ts` for the control surface;
- `do/server.ts` for the tenant's Durable Object.

A few endpoints handle raw requests outside the contract: the OAuth endpoints,
the Nix binary-cache protocol, the commit WebSocket, and endpoints that stream
objects.

## Deployments and upgrades

`cupboard deploy` is another name for `cupboard init`. It creates any missing
resources, finding them by name. It then applies the D1 migrations, uploads both
Workers, and records the deployment's phase in D1.

Some releases change the format of stored data. These releases roll out in
phases, `current`, `expanded`, `native-reads` and `contracted`, so that old and
new Workers can run side by side.

Each tenant's object also has its own data to migrate. It records how far it's
got as its **local step**: a number that shows which per-object data migrations
it has applied. Three things wake tenants whose local step is behind the step
that the build needs:

- the deploy itself;
- `cupboard deployment resume`;
- the hourly `local-step-sweep` job.

The deploy won't contract D1 until every active or suspended tenant has reached
the local step that the contraction needs.

Rolling back the Workers doesn't roll back the data.
