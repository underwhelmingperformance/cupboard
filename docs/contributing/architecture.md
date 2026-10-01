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

A deployment has two Workers, one Durable Object class that serves tenants, one
D1 database, one R2 bucket, two KV namespaces, and a queue with a dead-letter
queue. The diagram shows how they connect:

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

The raw cache read probes use the same read credentials as the Nix routes.
Availability and attestation probes report cache state; the metadata probe
returns complete narinfos for a bounded page of store paths. For public caches,
the metadata probe admits the page once and reads each canonical narinfo through
`CachedTenantReads`, so each entry uses the existing Workers Cache. Private
pages read committed versions and bounded R2 bodies. Reuse-view pages go to the
tenant object, which verifies the selected candidates and rechecks the view
revision before returning the page. Each page checks its source scope; the
client's traversal across pages and sources is not an atomic closure snapshot.

`POST /api/v1/attestation-info` discovers stored attestation descriptors for a
cache. The same route is available under a named-cache prefix. It accepts up to
32 unique store-path hashes, optional exact predicate-type filters and an
optional expected scope version. Several predicate types match any of those
types. An omitted filter returns every descriptor. Entries preserve request
order and distinguish missing paths from published paths with an empty list.
Published entries include the current NAR hash and each matching descriptor's
digest, predicate type and size. Discovery reports metadata; bundle verification
checks the signer, issuer, predicate and NAR subject.

The Worker reads committed D1 reference generations and canonical R2 lists with
at most six simultaneous object reads. Requests are limited to 64 KiB, lists to
1 MiB and responses to 4 MiB. A partial page reports `nextIndex` after the
processed prefix. The next request submits the remaining hashes and the previous
page's `scopeVersion` as `expectedScopeVersion`. Lifecycle or access changes
produce a `scope-changed` refusal. Private pages revalidate read credentials
before returning. Malformed and oversized lists produce typed errors; provider
failures remain temporary failures. Generation checks retain the existing
acceptance of public lists without valid generation metadata.

The read capability header advertises `attestation-info-v1`. Clients may use
bounded individual list reads when this capability is absent. An authentication
or storage failure does not permit fallback.

It also runs the **scheduled work**: the hourly cron trigger, and the consumer
for the maintenance queue.

### The tenant Worker

The tenant Worker is called `cupboard-tenant`, and its configuration is
`wrangler.tenant.jsonc`. It defines the `CupboardServer` Durable Object class,
and a second entrypoint called `CachedTenantReads`, which serves public reads.

It also defines a second Durable Object class, `VersionedR2ObjectRollbackGuard`,
which has no binding, so nothing can create an instance of it. Cloudflare
refuses to deploy an earlier Worker version across a change to a Worker's
Durable Object classes, so this class stops a rollback of the tenant Worker to a
version from before the change to versioned R2 object keys.

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

| Table                                                          | What it stores                                                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tenant`                                                       | The list of tenants: status, owner identity, config version, the tenant read-credential verifier, and maintenance position.  |
| `tenant_cache_read_credential`                                 | The verifier for each cache that has its own read credential.                                                                |
| `cache_lifecycle`                                              | Each cache's access mode, generation, read revision and deletion time.                                                       |
| `blob_state`                                                   | The set of verified NARs, shared by all tenants: hashes, sizes, compression, and the deadline for reaping.                   |
| `blob_ref`                                                     | One reference for each committed narinfo version, from a tenant's cache to a NAR hash. These references authorise NAR reads. |
| `tenant_blob`, `tenant_cas_blob`                               | Which NARs and attestation bundles each tenant uses, for counting storage.                                                   |
| `tenant_usage`                                                 | Each tenant's usage counters and quota. A `CHECK` constraint refuses a charge that would go over the quota.                  |
| `cas_object`, `attestation_ref`                                | Stored attestation bundles and their references.                                                                             |
| `object_incarnation`, `object_deletion`                        | Bookkeeping for versions of R2 objects, and scheduled deletions.                                                             |
| `control_auth_key`, `control_trust`, `global_admin`            | The control plane's signing keys (with the private part wrapped), its trust rules, and the first operator.                   |
| `deployment_transition`                                        | The state of each schema transition that the deploy has started.                                                             |
| `deployment_phase`                                             | The deployment phase that v0.0.34 and v0.0.35 read. The deploy keeps it up to date for a rollback to those releases.         |
| `local_step_wake_cursor`                                       | No longer read. A later transition's contract migrations will drop it.                                                       |
| `manifest_state`                                               | Kept for older databases. Nothing reads it.                                                                                  |
| `tenant_maintenance_failure`, `tenant_maintenance_eligibility` | The results of maintenance runs, and hints about which tenants to wake.                                                      |
| `instance_config`                                              | The deployment's instance name.                                                                                              |

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
| `staging/<pushId>/attestations/<uploadId>`                  | Attestation bundles awaiting attachment, removed on session expiry or by R2 lifecycle.  |
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
- `local-step`, for the tenants that haven't yet reached the data-migration step
  that the deployed build needs, and whose objects are stalled or haven't been
  woken. Each job lists up to 20 tenants. See [Local steps](#local-steps).
  Earlier builds added a `local-step-sweep` job; the consumer acknowledges one
  without doing anything.

A tenant's Durable Object can also add a job. When a commit leaves bytes waiting
to be verified, the object adds a `tenant-verify` job.

The control Worker consumes the queue one message at a time, with up to four
consumers running at once. A message that fails is retried after 60 seconds, up
to three times. After the third retry, it goes to the dead-letter queue,
`cupboard-maintenance-dlq`. cupboard doesn't read the dead-letter queue. The
next hourly run adds fresh jobs instead.

### The subrequest allowance

Each invocation of a Worker can make a limited number of calls to D1, R2 and
Cloudflare's other services. The [Workers limits] list 1,000 on the Free plan
and 10,000 on the Paid plan. D1 and R2 binding calls count against the same
allowance, and one `D1Database.batch()` counts as one call however many
statements it contains. cupboard counts its own D1 and R2 calls against the
allowance in `CUPBOARD_SUBREQUESTS_PER_INVOCATION`, and keeps 100 calls in
reserve for work that it doesn't count (`subrequestSafetyReserve` in
`packages/protocol/src/platform.ts`).

The [D1 limits] page still lists 50 queries per invocation on Free and 1,000 on
Paid. Those figures conflict with the Workers limits, and with a test on the
Paid plan in which 10,000 D1 calls completed and the 10,001st failed. The Free
allowance hasn't been checked against a hosted Worker. cupboard uses the Workers
limits for both plans.

Both Wrangler configurations leave `limits.subrequests` unset, so Cloudflare
applies the account's plan limit. The allowance doesn't extend the tenant
object's critical-section deadline.

[Workers limits]: https://developers.cloudflare.com/workers/platform/limits/
[D1 limits]: https://developers.cloudflare.com/d1/platform/limits/

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
3. If the cache is private, the control Worker authenticates the request. For
   static HTTP Basic credentials, it uses the cache's own salted verifier if the
   cache has one, and the tenant's verifier otherwise. For an access token, it
   calls the tenant's Durable Object to verify the JWT and its
   `cache:content-read` grant for the addressed cache. The control Worker then
   serves the read itself, with `Cache-Control: no-store`.
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

Public narinfo and NAR reads, and private reads authenticated by static
credentials, do not wake the tenant's Durable Object. Token-authenticated
private reads call the object once per HTTP request; the NAR stream stays on the
control Worker. These reads also use the object: `nix-cache-info`, the public
key, attestations, availability queries, and reuse views.

A private reuse view accepts the tenant's static credential or an access token
with `view:content-read` for that view. A view grant does not authorise direct
reads from the view's source caches. Content-read grants cannot select a root,
and publication grants do not imply content-read permission. The existing
`cache:read` operation authorises cache metadata through the admin API.

Nix sends access tokens through HTTP Basic authentication, with user
`cupboard-oidc` and password `cupboard-access+jwt:<token>`. Read endpoints also
accept Bearer authentication. `cupboard run` exchanges a fresh GitHub OIDC token
for narrowly scoped read access and renews it while its child command runs. It
writes each replacement to a temporary netrc atomically, and selects that file
through the child's `NIX_CONFIG`. Nix and Cupboard's direct HTTP readers reread
the netrc for subsequent requests. When the command exits, the wrapper stops
renewal and removes the file. Removing the file does not revoke issued JWTs;
normal token expiry and key retirement still apply. This lifecycle adds no
per-token revocation state.

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

- A rule for interactive sign-in normally gives a token that lasts 10 minutes,
  and a refresh token. The refresh token's family expires after 30 days.
- A rule for CI, or an OIDC exchange that requests only content-read grants,
  gives a token that lasts 15 minutes, and no refresh token.

A client can also exchange a cupboard access token for one with fewer grants.

CI read acquisition uses the extension grant
`urn:cupboard:params:oauth:grant-type:read-access` at the tenant token endpoint.
The request contains an external ID token and a bounded `read_resources` array
with up to sixteen distinct resources, including at most one reuse view. The
server selects one trust rule using the existing identity precedence, then
resolves exact read grants against current resource state. Public resources need
no content-read grant. Existing private resources require content-read; an
absent cache accepts scoped metadata authority, which publication grants already
imply. The read response includes access and priority facts for setup
validation. Acquisition never creates a cache. Ordinary token exchange keeps its
strict requested-grant semantics.

Read acquisition always issues a 15-minute token without a refresh token,
including metadata-only and zero-authority results. Request-time checks still
apply after visibility or lifecycle changes. Metadata authority authorises an
absence response only while the addressed cache is absent or deleted.

For a control token, `POST /token` on the bare host works the same way, but
matches against the control-plane trust rules in D1's `control_trust` table. It
issues a token that lasts 10 minutes, signed with the current control key.

`POST /signup` makes the first caller who presents the deployment's claim secret
the admin, the first operator. `cupboard init` sets the secret on the control
Worker, as `CUPBOARD_SIGNUP_SECRET`, only for the claim, and removes it
afterwards. The caller also presents an ID token from any OIDC issuer. The
Worker checks the secret before it decodes the token, so a caller without the
secret can't make it fetch anything from an issuer. In one D1 batch, it records
the admin in `global_admin` and creates the control trust rule `signup`, which
pins the token's issuer, subject and audience. Anyone else who tries to claim
the deployment afterwards is refused. With `CUPBOARD_LOCAL_DEV` set, the issuer
can be a loopback HTTP address, but the claim still needs the secret.

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
- Static read credentials are stored in D1 as a user name, a salt and a salted
  SHA-256 hash. The server generates each password from 32 random bytes.

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
Workers, and records the deployment's progress in D1. On a deployment that has
an admin, it first checks an admin token against the control Worker.
[Upgrading](../operator/upgrading.md) describes this from an operator's point of
view.

### Schema transitions

A **schema transition** is a group of D1 migrations in two parts. The expand
migrations add schema. Every build that can still be deployed or rolled back to
must be able to run against the expanded schema, not only the preceding build.
After a skip-level upgrade, such as one from v0.0.33, the deployed build is
older than the preceding release, and a rollback can cross two releases. The
contract migrations remove what the preceding build reads, and run once both
Workers' deployments send all traffic to the new build.

The transitions are listed in order in `schemaTransitions` in
`@cupboard/protocol/deployment`, and every migration file belongs to exactly one
of them. Concatenating each transition's expand then contract migrations, in
list order, must give the migration files in name order. The deploy stops with
an error when the artifact's files don't match the transitions. Once a release
has shipped a transition, its migration lists don't change, and a new migration
goes in a new transition.

The current build defines five transitions:

- `cache-identity`: migrations `0000` to `0027` are its expand migrations and
  `0028` to `0030` its contract migrations. Its expand migrations include the
  base schema (`0000` to `0019`), because no transition comes before it. Its
  contract step is local step 4.
- `deployment-transitions`: migration `0031` creates the `deployment_transition`
  table. It has no contract migrations and no contract step.
- `attestation-path-index`: migration `0032` adds an index on `attestation_ref`
  by tenant, store path and generation, which attestation inheritance searches.
  It has no expand migrations and no contract step, and `0032` is its contract
  migration. Migration `0028`, a contract migration of `cache-identity`,
  rebuilds `attestation_ref` and drops every index that it doesn't recreate, so
  the index must be created after it. The deploy applies `0032` after the
  upload, once both Workers serve the new build, and the inheritance lookup
  scans `attestation_ref` until then.
- `local-step-attempts`: migration `0033` adds the columns of the `tenant` table
  that record each tenant's last attempt at its local-step work. It has no
  contract migrations and no contract step.
- `publication-identity`: migration `0034` creates the independent `publication`
  table, which records the upload that committed each NAR reference. The earlier
  cache-identity contract rebuilds the reference table, so upload ownership uses
  a separate table. This transition has no contract migrations or contract step.

A transition is **independent** when its expand migrations don't depend on the
contract migrations of the transitions before it and don't change existing rows.
Once every earlier transition has expanded, the deploy may apply an independent
transition's expand migrations before the earlier transitions' contract
migrations. A transition that isn't independent is **dependent**, and can only
expand once every earlier transition is complete. Otherwise its expand
migrations could run only after the upload, and the new Workers would run
without them until then. `deployment-transitions`, `attestation-path-index` and
`local-step-attempts` are independent, so a deployment on v0.0.33 upgrades
directly. A later release that adds a dependent transition can be blocked, and
its error lists the releases that complete the earlier transition, aren't older
than the deployed release, and don't include the later transition. A fresh
deployment is never blocked, because every transition completes on it before the
upload.

The `deployment_transition` table has one row for each transition that the
deploy has started. The state is `expanded` once the transition's expand
migrations are applied, and `complete` once its contract migrations are applied
too, or immediately for a transition with no contract migrations and no contract
step. The row's `contracted_at` records when the deploy started the contract
migrations. The deploy sets it before the first of them runs, so a run that
stops part-way still leaves it set. It stays empty for a transition without
contract migrations. A transition with no row is **pending**. The deploy creates
the table with `CREATE TABLE IF NOT EXISTS` once its checks pass, before it
applies the first migration, because it records `cache-identity` before it
applies migration `0031`. Recorded states only rise: a rerun can't lower
`complete` to `expanded`, and repeating a state keeps its timestamp.

When the deploy reads the states, it reconciles them with the `deployment_phase`
row that v0.0.34 and v0.0.35 wrote. `contracted` means that `cache-identity` is
complete, and `native-reads` means that it has at least expanded. Released
builds only recorded these two names. Development builds between releases also
recorded `current` and `expanded`, which don't show that the expand migrations
ran, so the deploy ignores any other name. The deploy writes the row for
`cache-identity`, because v0.0.34 and v0.0.35 read it: `native-reads` once every
active or suspended tenant has recorded local step 4, and `contracted` once the
contract migrations have run. If a run stops after it records `cache-identity`
complete and before it writes `contracted`, the next run writes `contracted`.
The deploy also corrects a row with the wrong local step, replaces a phase name
that no release wrote, and creates the table again if a later release dropped
it. The Workers of the current build don't read the row.

### One deploy run

One `cupboard init` run applies the transitions in list order:

1. Read the recorded states, before applying a migration or uploading a Worker,
   and stop with an error in any of these cases:
   - a row with a transition ID or state that the build doesn't define;
   - an artifact whose migrations don't match the transitions;
   - a migration file whose digest differs from the digest recorded when it was
     applied, including a migration of a complete transition;
   - a transition recorded as complete although one of its migrations is missing
     from `d1_migrations`;
   - a dependent transition that follows a transition that isn't complete.

   One kind of row doesn't stop the deploy: a row that a later release wrote for
   its own transition, in state `expanded` or `complete`, with `contracted_at`
   empty. See
   [Deploying an older release over a newer one](../operator/upgrading.md#deploying-an-older-release-over-a-newer-one).

   The deploy shows the plan first. When the plan shows a blocked transition,
   the review menu offers only changes to the plan and Cancel. On Cancel, or
   with `--yes`, the command stops with the blocking error before it creates any
   Cloudflare resource or R2 key.

2. Before the upload, on a fresh deployment, apply every transition's expand and
   contract migrations and record each transition complete. A deployment is
   fresh when its database has no `tenant` table, or when the table has no rows
   and neither Worker script exists. A first deploy that stops before the upload
   leaves one of those states. No Workers of an earlier build use such a
   database, and it has no tenants to wake.
3. Before the upload, otherwise, apply the expand migrations of every transition
   that isn't complete and record it `expanded`. A transition with no contract
   migrations and no contract step is complete immediately.
4. Upload both Workers and configure their triggers and secrets.
5. After the upload, read the states again and repeat the checks on the applied
   migrations. Then check once that each Worker's deployment sends all traffic
   to one version and that both Workers report the new build. This check runs on
   every deploy, including one on which every transition is complete. Then, for
   each transition that isn't complete, wake the active or suspended tenants and
   wait until every one has recorded the transition's contract step (see
   [Local steps](#local-steps)). For `cache-identity` only, write `native-reads`
   to the `deployment_phase` row. Then apply the contract migrations and record
   the transition `complete`.
6. Wake the tenants again and wait until they reach local step 5.

A failed serving check, or tenants that haven't recorded the contract step, stop
the run in step 5. The contract migrations of the incomplete transition stay
unapplied, and that transition stays `expanded`. The error lists the Workers, or
a sample of the tenants below the contract step. If step 6 fails, the contract
migrations have already been applied and recorded. A wait stops with an error
once ten minutes have passed since its wake and no pending tenant is classified
as working. Tenant objects that are making progress continue after it stops.

There is no elapsed-time delay and no second deploy that only applies contract
migrations. The
[Workers deployments API](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/)
reports the configured traffic allocation, not whether every old invocation has
finished. A
[Durable Object code deployment](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
restarts its objects. An old in-flight request is stopped when it next touches
object storage, and WebSockets are closed. Old Worker HTTP requests can
continue. The contracted D1 schema rejects their references to removed columns,
and the grant migration installs triggers that reject writes in the old grant
format. Those requests can fail during the transition and must retry against the
new build.

### Local steps

Each tenant's Durable Object also has its own data to migrate. It records how
far it has got as its **local step**: a number that shows which per-object data
migrations it has applied. A transition's **contract step** is the local step
that every active or suspended tenant must record before the deploy applies the
transition's contract migrations. The **required local step** is the local step
that every active or suspended tenant must reach now: the contract step of the
first incomplete transition that has one, or otherwise the build's final step.
Until the deploy records `cache-identity` complete, an object can report at most
step 4, so the required local step is 4 until then. Once `cache-identity` is
complete, the required local step is never below 5, even while a later
transition with a lower contract step is incomplete.

The tenant row records the local step, which the object never lowers, and three
columns that describe the object's last attempt at its local-step work:
`local_step_attempted_at`, `local_step_progressed_at` and `local_step_error`.
Migration `0033` adds them.

A wake starts an object's local-step work, and the object then continues by
itself on its alarm:

1. `localStep.wake` adds a `local-step` job to the maintenance queue for the
   pending tenants that are stalled or unwoken (see below), with up to 20
   tenants in each job. Every cron tick adds the same jobs, which covers a lost
   message and an object that has stopped.
2. The queue consumer calls the object of each listed tenant that is still
   pending, four at a time. The object stores the requested step, sets its alarm
   and runs one page of the work.
3. The object runs further pages on its alarm. After a page that made progress,
   the next page runs at once. After a page that made no progress or failed, the
   next page runs 30 seconds later, after the maintenance retry delay.
4. The object stops once it has recorded the requested step, or once no page has
   made progress for ten minutes. The next wake starts it again, so with the
   default hourly cron trigger an object that has stopped retries for ten
   minutes each hour. When the object finds that its tenant row already records
   the requested step, it runs no page.

A page is one bounded interval of the object's schema migrations, or one bounded
call of its data work. A page made progress when it recorded a higher step,
projected, moved or rewrote an item, saved a cursor, or committed migration
work. Recording a step that the tenant already had isn't progress. After such a
recording, the cursor saves of the restarted projection and object moves aren't
progress either, until a wake asks for a higher step.

The object writes each attempt to its tenant row: when the page ran, a summary
of its error or none, and the time of the page when it made progress. It always
writes a failed page, a page without progress and a page that records a step.
After it writes a page that made progress and left work to do, it skips the
writes of further such pages for 30 seconds, so the recorded progress can be up
to 30 seconds old. The object keeps that interval in memory, so after a failed
page, a page without progress, a recorded step or a restart, the next page that
made progress is written at once. A page that records the requested step clears
the attempt time, because the object has no work left, so a tenant that a later
required step leaves pending reads as unwoken until a wake reaches it. When the
object stops after ten minutes of pages that made no progress and didn't fail,
it records the error `gave up after 10 minutes without progress`. When a wake
fails, or finds that the control plane never configured the object, the queue
consumer writes the error, unless the row's attempt time has changed since the
consumer read it before the wake.

`localStep.status` counts the active or suspended tenants that have reached the
required local step, and puts each pending tenant in one class, measured over
the ten minutes before the request. A tenant is **unwoken** when no attempt at
the outstanding work has been made in those ten minutes and the last attempt
didn't fail. Otherwise its object has attempted the work, and the tenant is:

- **working**, when its last progress is within the ten minutes, even if its
  last attempt failed, or when it hasn't made progress yet and hasn't failed;
- **stalled**, when its last progress is older than ten minutes, or when it
  hasn't made progress and its last attempt failed.

The status lists up to 20 stalled tenants in `stalledSample`, each with the time
of its last attempt, its last progress and its error, and up to 20 unwoken
tenants in `unwokenSample`, with the time of their last attempt. Both
`localStep.status` and `localStep.wake` report the required local step as
`required`; the status also reports the build's `current` step, and the wake
reports how many tenants are pending and how many it `enqueued`. The wake and
the cron trigger select the tenants below the required local step.

The deploy, and `cupboard deployment resume`, call `localStep.wake` once and
then read `localStep.status` every five seconds until no tenant is pending, with
no limit on the number of reads. They stop with an error once no pending tenant
is working and ten minutes have passed since the wake. The error lists the
stalled tenants with their errors, and the unwoken tenants. The tenant objects
don't depend on the deploy: an object that is making progress continues after
the deploy stops or is interrupted, and an object that has stopped waits for the
next wake.

This build defines five local steps:

- Step 1 projects missing lifecycle rows into D1, at most 36 caches per page.
  The local schema migrations reconcile registrations and fill identity columns
  before the local contraction.
- Step 2 moves private-cache objects off their old `private/` keys.
- Step 3 moves objects from later cache generations onto keys that include the
  generation. Steps 2 and 3 each move at most 100 objects per page. A path whose
  object hasn't reached its generation key returns 404 until the move, or a new
  push, makes it available at that key.
- Step 4 imports legacy retention and grace policies in bounded batches. Cache
  retention edits are refused while that import is pending. The policy list and
  removal procedures stay available, to recover from an import that exceeds its
  supported rule bound.
- Step 5 rewrites stored trust rules and refresh-token grants once D1 records
  `cache-identity` complete. A page rewrites at most 100 rules and 100 families.
  Completion enables local database triggers that reject the old format.

Each object caches its reading of the transition states for one minute, so the
grant rewrite at local step 5 reads them again before it starts.

### Stored cache grants

A stored cache grant identifies its cache in one of two formats. A **selector
grant** uses `_default` for the default cache, the cache's name for a public
cache, and `_private-<name>` for a private cache. A **scope grant** identifies
the default cache or a named cache whatever its access. A trust rule's grant can
contain a template. A refresh-token family contains the concrete caches that
were granted. This build reads both formats.

Until the `cache-identity` transition is complete, new grants use the selector
format, so that the previous release can read them. A grant for a named cache
whose access is known uses the selector for that access. A template, or a name
whose access isn't known yet, gets both the public and the private selector, and
current readers combine them into one grant. cupboard refuses to change a
cache's access until `cache-identity` is complete, so an existing selector keeps
its meaning for the whole transition.

The control plane can't look up a tenant cache's access, so it stores every
named-cache grant with both selectors. When a template is too long to take the
private selector's prefix, adding the rule returns
`CACHE_GRANT_MIGRATION_PENDING` (409) until the deployment is complete.

The `cache-identity` contract migrations rewrite `control_trust` in the scope
format, and local step 5 rewrites each tenant's `oidc_trust` and
`refresh_token_family`. A grant that was prepared before a tenant finished that
rewrite is checked again just before it's written, and converted if needed.
Database triggers then enforce the scope format.

### Checking the migrations

For each N, `pnpm check:migrations` takes a deployment whose first N transitions
are complete and whose later ones are pending, and replays the migrations in the
order that the deploy would apply them. It fails if any of those orders fails to
apply, or if one produces a different schema from name order. It also fails when
the drizzle journal lists the migrations in a different order from their names.
It compares schemas, not rows. It doesn't cover one case. Suppose an independent
transition has contract migrations, and a deploy expands it before an earlier
transition's contract migrations run and then stops. If a later release adds
another transition before that transition completes, the later deploy applies
the files in an order that the check doesn't replay.

### Rollbacks

Rolling back the Workers doesn't roll back the data. A tenant that has
initialised under a build has already contracted its own SQLite schema, even if
D1 hasn't yet recorded the transition complete. The `cache-identity` expand
migrations keep both cache representations and mirror inserts from either
writer, and its contract migrations remove that compatibility. The tenant Worker
upload is therefore the point after which a rollback can't recover: after an
object contracts its SQLite schema, complete the deployment to recover.

The tenant objects and the control-plane trust gate ignore a
`deployment_transition` row with an unknown transition ID, and count an unknown
state of a known transition as complete, because a later release may only add
states after `complete`. The `deployment.transitions` control procedure lists
every row that the build doesn't define under `unrecognised`.
