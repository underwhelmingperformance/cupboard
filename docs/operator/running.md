# Running a deployment

Once a deployment is running, it mostly looks after itself. This page explains
what it does on its own, what you should keep an eye on, what to do when
maintenance fails, and what it costs.

## What happens automatically

The control Worker has a cron trigger that runs every hour. Each run:

- queues maintenance for up to 100 active tenants that are due for it.
  Maintenance runs garbage collection, checks stored objects, and retires
  access-token keys.
- deletes the data of up to ten tenants that are being removed.
- deletes stored files that no cache in any tenant uses any more.
- retires control keys that are due to be retired.
- wakes the tenants that still have upgrade migrations to finish and have
  stalled or haven't been woken yet. A woken tenant then keeps working on its
  own. See
  [When a deploy stops before finishing](./upgrading.md#when-a-deploy-stops-before-finishing).
- refreshes the list of tenants that the Workers use to decide which requests to
  accept.

An active tenant becomes due for maintenance when it has work to do, such as an
expired retention root or grace period, or six hours have passed since its
maintenance eligibility was last reconciled. Each hourly run queues at most 100
due tenants. Queue delivery, other due tenants and maintenance failures can
delay completion. Suspended tenants are skipped.

## Maintenance and the queues

The hourly job doesn't do tenant maintenance itself. It sends the work as
messages to the `cupboard-maintenance` queue.

If the queue consumer cannot process a message, it retries after one minute, up
to three times. After that, the message goes to `cupboard-maintenance-dlq`,
which cupboard does not consume. A failed tenant maintenance or removal pass
follows a different path: the consumer records the failure in D1 and
acknowledges the message. The hourly job can queue the tenant again while its
work is due.

Inspect each dead-letter message and the Worker logs before purging it. The
hourly job selects only bounded batches of due tenants and does not recreate
every kind of message. Check that the work completed or arrange another attempt
before you purge the message.

## What to watch

### Health

`/healthz` returns `ok` while the control Worker is running. `/_version` returns
the build that's deployed:

```sh
curl -fsS https://cupboard.example.workers.dev/healthz
curl -fsS https://cupboard.example.workers.dev/_version
```

Neither endpoint checks D1, R2 or the other storage services, so a healthy
response doesn't mean that reads and pushes are working.

### Logs

Both Workers have Workers Logs turned on. To follow the logs live, run:

```sh
wrangler tail cupboard
wrangler tail cupboard-tenant
```

The CLI writes diagnostic files only when `--log-file <path>` is supplied. Files
contain the existing structured logs at trace level, independently of the
console's verbosity. They include the active OpenTelemetry `trace_id` and
`span_id`, structured error causes, HTTP attempts, response and body failures,
retry outcomes, WebSocket events and subprocess completion counters.

```sh
cupboard --log-file /tmp/cupboard-push.jsonl.zst push \
  https://cupboard.example.workers.dev/t/acme /nix/store/...
```

The suffix selects streaming compression: `.zst` uses Zstandard level 3 with
frame checksums, `.gz` uses gzip, and other suffixes write plain JSONL. Each
invocation replaces its selected file. Use a distinct path for each concurrent
process. Files rotate after 10 MiB of uncompressed records, with two backups,
and use mode `0600`. The in-memory queue is bounded; overload produces a
dropped-record count. Normal shutdown flushes and closes the compressor. An
abruptly terminated process can leave an incomplete final frame or record.

Cupboard's GitHub Actions enable the same file logger automatically. Each
process writes a separate file in the job's shared diagnostic directory. The
first action uploads the directory from its post step after the other post steps
finish. Artifacts use the `cupboard-diagnostics-` prefix and the repository's
retention setting. Older CLIs that reject `--log-file` run without CLI file
logging; the action's own logs remain available. An upload failure produces a
warning and does not replace the command's result.

Public requests receive a fresh `x-request-id` before authentication and
routing. Client HTTP and WebSocket logs record this response header and
Cloudflare's `CF-Ray` header. The server forwards its request ID through trusted
bindings and includes it in logs and native trace attributes. Incoming client
trace IDs are untrusted attributes; they do not determine server trace IDs,
parentage or sampling. The [native Workers tracing API][custom-spans] does not
currently support explicit span links, so client parent identifiers are recorded
as attributes. Cloudflare's account-level incoming trace-context acceptance must
remain disabled. Forward to origin is not needed for Worker bindings.

Responses receive their request ID after cache lookup. Cached responses exclude
request IDs, trace context, client correlation headers and their `Vary` tokens.
A cache hit therefore receives a new request ID.

Extract a diagnostic artifact and pass its directory to the tracing script:

```sh
pnpm diagnose:push --client-logs /tmp/cupboard-diagnostics \
  https://github.com/acme/app/actions/runs/123/job/456
```

The report lists diagnostic artifacts for the workflow run and reads plain,
compressed and rotated files from the supplied directory. It reports attempt and
response counts, failures, recovery, cancellation, dropped records and
incomplete files. Probe attempt deadlines and final logical probe outcomes are
separate: three expired attempts can exhaust one probe. HTTP deadline aborts are
not caller cancellation. The report excludes both from transport-failure counts
and reports HTTP attempt deadlines and caller cancellations separately. Older
transport failures without a classification are reported as unclassified. The
GitHub job's recorded times bound the query. Without a job URL or `--since`,
client timestamps bound the query with an allowance of one minute on either side
for clock differences.

When client logs are supplied, the report selects server activity by returned
request IDs, Ray IDs and exact client trace/span pairs in untrusted server
attributes. It follows the matching server request and native trace identifiers
to include related logs and spans. Concurrent jobs are excluded unless their
records share a matching identifier. Path/time candidates are reported
separately and do not select server activity. Client trace IDs never identify
native server traces.

To follow reads across both Workers in one report, add
`--control-worker cupboard` to the default tenant-Worker query. To restrict a
long job to its failure interval, supply both `--from` and `--to` as UTC
timestamps. This interval overrides the job timing and cannot be combined with
`--since`:

```sh
pnpm diagnose:push --client-logs /tmp/cupboard-diagnostics \
  --worker cupboard-tenant --control-worker cupboard \
  --from 2026-10-26T01:26:00Z --to 2026-10-26T01:29:00Z
```

When native trace IDs are already known, add `--trace-id <id> [id...]` to
retrieve only those traces. Supply the control and tenant trace IDs separately;
the client OpenTelemetry trace ID is not a native trace ID. The query batches
identifiers and pages both Workers through one bounded query pool. The report
labels identifier-filtered retrieval as deliberately partial. Omit `--trace-id`
to retrieve the interval before selecting activity through the client logs.

Without client logs or a trace-ID filter, the report covers the whole query
window, which can include concurrent jobs. A quiet interval does not identify a
job boundary. Server telemetry can be sampled, delayed or unavailable, and
clocks can differ. An unmatched client record does not prove that the server did
not execute the request. These diagnostics do not change retry limits or make
replay-unsafe operations safe to repeat.

[custom-spans]:
  https://developers.cloudflare.com/workers/observability/traces/custom-spans/

Dependency metadata probes run in the control Worker. Their
`cache-metadata-probe` spans record the upstream OpenTelemetry trace and span
IDs, requested path count, found and missing counts, continuation status and
outcome. Each probe also records the cache's public or private access and the
number of canonical narinfo read attempts. A public page checks path authority
in one database query and reads canonical narinfos only for present paths. The
path-set fingerprint identifies repeated page requests without recording their
request bodies. The diagnostic groups fingerprints by the cache request path, so
checking the same paths in different caches produces separate groups. A repeated
fingerprint can indicate a retry or another check of the same page; it does not
prove a repeated build or upload.

From a repository checkout, use the diagnostic script with a GitHub Actions job
URL and `--worker cupboard` to inspect the control Worker's activity. Use
`--worker cupboard-tenant` to inspect canonical narinfo reads and publication
work. The diagnostic groups metadata pages by their upstream trace ID when the
deployed spans include that attribute. It reports summed request durations and
the observed wall-clock interval separately because requests can overlap.

Cloudflare's native trace IDs remain separate from the upstream OpenTelemetry
trace IDs. The upstream attributes connect the client check to the native Worker
spans; they do not change Cloudflare's native span parentage. A job's time
window alone cannot distinguish its requests from other concurrent jobs.

To find recorded HTTP 500 responses during the last 48 hours, query both
Workers:

```sh
pnpm diagnose:push --worker cupboard --since 2880 --status 500 \
  --hostname cupboard.example.workers.dev
pnpm diagnose:push --worker cupboard-tenant --since 2880 --status 500 \
  --hostname cupboard.example.workers.dev
```

`--since` is in minutes. A status query requires either `--since` or a GitHub
Actions job URL, or an explicit `--from`/`--to` interval. `--hostname` restricts
the query to an exact request Host header; omit it to query every hostname for
the selected Worker. Add `--json` to get the matching requests with their
timestamps, request IDs and trace IDs. URLs in the report exclude credentials,
query parameters and fragments.

This mode queries invocation response records. Errors inside an open commit
WebSocket or an RPC invocation do not necessarily produce an HTTP 500 response.
Cloudflare's log retention and sampling limit which responses can be found.

### R2 read failures

Waiting for `R2Bucket.get()` to return has a total budget of 15 seconds. An
enclosing storage deadline can shorten that budget. The server retries only
completed native rejections for internal error (10001), unavailable service
(10043) and rate limiting (10058), with at most three attempts and jittered
backoff inside the same budget. Missing objects and conditional metadata-only
results are not retried. Retries stop before consuming the invocation's
subrequest reserve. See [R2 error codes][r2-errors] for the provider
definitions.

A pending native `get()` is not retried within the same server request. When the
wait times out, or recognised transient rejections exhaust the attempt limit,
HTTP reads return 503 with `Retry-After: 5`. The timer ends before the caller
consumes the returned stream. A healthy NAR stream can continue beyond 15
seconds. A body failure does not repeat `get()` or replay bytes, and this policy
does not change write retries.

The native binding has no abort option for `get`. A timed-out operation can
continue after the server returns 503. The server observes late rejection and
cancels a late unused body once, best-effort within the invocation's lifetime.
Cleanup does not prove that Cloudflare cancelled the underlying operation. A
client retry can overlap abandoned work in an earlier invocation.

The `cupboard.storage.read` logger records `get()` starts, attempts, retries and
terminal outcomes at debug level. Each logical read has a `storageOperationId`
and a bounded `objectKey`; the identifier also accompanies late completion and
cleanup logs. The `r2-get` span records its outcome and attempt count. The
recorded time excludes body transfer.

The diagnostic report includes `get()` lifecycle records, native R2 outcomes,
invocation outcomes and invocation wall time separately from span duration.
Missing-object probes are separate from native read failures. A span without
terminal response attributes has an unknown outcome, even if its duration is
zero or its metadata says `OK`. Cancelled invocations can force-close spans, so
the recorded span duration can understate the elapsed time. A missing terminal
record does not prove that the backend did not execute the operation.

Verify both deployed Worker revisions as well as the action or CLI revision.
Updating only the client does not enable server deadlines. After deployment,
compare normal read latency, timeout counts, late completions and log volume. A
bounded 503 improves failure handling but does not establish the cause of an R2
stall.

[r2-errors]: https://developers.cloudflare.com/r2/api/error-codes/

### Maintenance failures

When a tenant's maintenance or removal fails, the failure is recorded in the D1
table `tenant_maintenance_failure`. Each row shows the tenant, how many times in
a row it has failed, the last error, and when it last failed and last succeeded.
To see the table:

```sh
wrangler d1 execute cupboard --remote \
  --command 'SELECT * FROM tenant_maintenance_failure'
```

If a tenant keeps failing, the last error and the Worker logs from around that
time are the place to start.

A verification attempt for a newly uploaded NAR fails when R2 returns an error,
or when the staged object changes while the queue consumer reads it. It also
fails when 60 seconds pass without the consumer completing a read of up to 1 MiB
from the staged object. When the commit declared the compressed object's hash
and size and the attempt also writes the NAR's canonical object, that limit is
30 seconds. The attempt then also fails when the write receives no bytes for 30
seconds, which covers the work after the last read and R2's answer to the write.
The tenant Worker records failed upload verification and publication attempts in
`pending_upload.settle_failures`. `last_settle_error` contains a controlled
failure category. Retries start after 30 seconds and double up to ten minutes.
The tenant Worker's `pending upload verification failed` log includes the upload
ID, category, phase and failure count, without provider messages or URLs. A
stored decode verdict remains available while publication retries, so the next
attempt does not decode the NAR again.

The queue consumer logs its own `pending upload verification failed` warning
when it abandons an upload. The warning includes the stage that was running
(`fetch`, `read` or `decode`) and the error's name, message and stack. Unlike
the tenant Worker's log, this warning records the error's own message, so it can
include R2 error text. For every newly uploaded NAR that it decodes, the
consumer also logs a `pending upload verification finished` event with the
outcome (`verified`, `nar-hash-mismatch`, `nar-size-mismatch`, `undecodable`,
`file-hash-mismatch` or `file-size-mismatch` when the staged object differs from
the client's declaration, `missing`, `abandoned`, or `aborted` when the pass
budget ends before verification finishes), the number of compressed bytes that
it read and NAR bytes that it decoded (`compressedBytes` and `narBytes`), the
number of chunks of up to 1 MiB that it decoded (`reads`), and the duration in
milliseconds.

The same event describes how the consumer read the object ahead of the decoder
with ranged gets into the isolate's pool of 8 MiB buffers:

- `ranges` is the number of ranged gets.
- `rangeBufferMisses` is the number of blocks that found every buffer in use at
  least once. A block can still get a ranged get later, when a buffer becomes
  free first. A high value means that concurrent verifications in the same
  isolate were sharing the four buffers.
- `rangeBudgetSkips` is the number of blocks that found, at least once, that the
  invocation's subrequest allowance could not cover a ranged get and a new head
  after it. A high value means that the pass was close to its subrequest
  allowance.
- `peakRangeBuffers` is the largest number of buffers that the verification used
  at once.
- `lostRangeBuffers` is the number of buffers that a cancelled or failed read
  kept. The pool allocates a new buffer in place of each one, so the isolate
  uses more than the pool's 32 MiB until the runtime frees the kept buffer.
- `rangeBufferAllocations` is the number of buffers that the isolate's pool has
  allocated so far. It stays at four or less unless reads have kept buffers.

Both log lines identify the upload by its upload ID and store path hash, and
include the NAR hash and NAR size that the client declared (`uploadId`,
`storePathHash`, `narHash` and `narSize`).

Each newly uploaded NAR whose promotion to a canonical object has started logs
exactly one `nar promotion finished` event, when its upload leaves verification.
The event includes the upload ID, store path hash and NAR hash. `outcome` is the
upload's final status: `servable`, `absent`, `over-quota` or `mismatch`. An
upload that leaves verification before a promotion starts, for example because
its bytes failed verification, logs no event.

`mode` describes the upload's last promotion attempt. It is `copy` when the
tenant Worker attempts to copy the staged object after verification, including
when it finds the canonical object already present. It is `fused` when the queue
consumer attempts to write the canonical object while verifying the upload,
which happens only for a commit that declared the compressed object's hash and
size. The CLI declares these values when `commit-batch` advertises `blob=1`.

The event also includes these fields when the last attempt reported them:

- `bytes`: for `fused`, the compressed bytes that the consumer read; for `copy`,
  the size of the compressed object;
- `durationMs`: for `fused`, the time from the start of the staged read until
  the write ended; for `copy`, the duration of the copy;
- `r2ErrorCode`, R2's error code when R2 refused or failed the write or the
  copy, such as 10037 when the bytes don't match the expected SHA-256.

A `fused` attempt has no `bytes` or `durationMs` when the queue consumer stopped
during the write without reporting it. For a servable upload,
`commitToServableMs` is the time in milliseconds from the client's first commit
to publication.

The tenant Worker logs `nar promotion attempt failed` when a copy throws an
exception other than a digest mismatch. The queue consumer logs the same event
when a write throws an exception or the verification pass ends during a `fused`
write. Mismatch verdicts produce no attempt-failure event. The event includes
the same identifiers, `mode`, `bytes`, `durationMs` and `r2ErrorCode`. Its
`outcome` is `failed` for an exception or `aborted` when the pass ends during
the write.

Publication operations negotiated with `publication-v1` have a hard recovery
deadline 24 hours after first commit acceptance. Retries, credential renewal,
reconnects, progress and suspension do not extend that deadline. Accepted work
can finish after its push lease expires, but an expired push cannot start new
transfers or publications. A recovery-expired result returns temporary failure
status 75 and requires a fresh push. Completed publications keep their normal
retention; the recovery deadline does not expire canonical objects.

Upload verification and attestation inheritance stop after twelve failed
attempts or 24 hours of eligible time. Eligible time starts with the first
attempt and includes active backoff time. Suspension stops this clock. Budget
continuations and active claim leases do not increase the failure count, and a
client retry does not reset either limit. Alarms use the earliest retry or lease
deadline.

An exhausted upload that has no committed reference releases its reservation and
staging object, then reports `absent`. The CLI returns temporary failure status
75 so the client can negotiate a new upload. A committed upload keeps its
reference, charge and retention decision. Durable cleanup queues publication
repair and inheritance before removing its pending marker. Failed cleanup
retries after ten minutes without another verification attempt.

Inheritance retries start after one minute and double up to one hour. Exhausted
inheritance releases the queued source-deletion deferral and retains safe
category, cache, path and generation diagnostics in
`attestation_inheritance_failure` for seven days. The same narinfo generation
cannot restart inheritance after those diagnostics expire. A new generation gets
a new retry budget. To restore evidence after exhaustion, attach existing
bundles explicitly with [cupboard attest attach], or publish a new generation.
Explicit attachment remains available for the exhausted generation.

[cupboard attest attach]: ../reference/cli.md#cupboard-attest-attach

### Upgrade progress

`cupboard deployment status https://cupboard.example.workers.dev` shows the
state of each schema transition and how many tenants still have migrations to
finish. See [Upgrading](./upgrading.md#when-a-deploy-stops-before-finishing).

### Storage

Tenant administrators can see how much storage their tenant uses with
`cupboard usage`. The R2 dashboard shows the total size of the bucket.

## Capacity and cost

cupboard uses Workers, Durable Objects, D1, R2, Workers KV and Queues. Check
Cloudflare's pricing for your plan. In general:

- R2 storage is usually the largest cost. R2 doesn't charge for egress, so
  serving NARs costs you requests rather than bandwidth.
- Every narinfo and NAR that a client fetches is a Worker request. The Free
  plan's daily request limit is only enough for small deployments.
- On the Free plan, the CPU time for each request is limited to Cloudflare's
  Free allowance. Each request can also make at most 1,000 calls to other
  Cloudflare services. When you deploy on the Free plan, `init` prints a warning
  that cupboard's own CPU limit wasn't applied.

You can cap each tenant's storage with a quota. Set it when you create the
tenant, or later with [`tenant set-quota`](./tenants.md#changing-a-quota).
There's no way to limit how many requests a tenant makes.

## Backups

Nothing is backed up automatically.

- D1 keeps
  [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
  history, so you can restore the database to an earlier point in time.
- cupboard has no command or procedure to export or restore a tenant's Durable
  Object storage.
- The R2 bucket doesn't have versioning turned on.

Treat a deployment as something that you can rebuild from your CI, not as the
only copy of anything.
