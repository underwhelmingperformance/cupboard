# Background reconciliation: design

This document designs work that the control Worker's hourly tick currently
selects: the offboarding drain, tenant maintenance, the missing-object demote
scans, the cache catalogue migration, the shared-object reapers, membership
refresh and control-key retirement. Some tenant work already continues on its
own alarm, and some inner loops are unbounded. The aim is that each kind
finishes as soon as the platform allows, that its progress and its stuck items
are visible to the operator, and that it keeps the correctness properties of the
local-step work: harmless under duplicate and concurrent delivery, facts that
are overwritten in place of counters, and no lease rows or self-continuing
message chains on the control plane.

It covers merged `main` at `bf9eb7380`, including the deployment and migration
progress repairs in PRs #412 and #413. This document is ready for implementation
review; it does not change the running system. Each phase below has its own
activation and rollback criteria.

## Background

### What the investigation found

The control Worker (`cupboard`) has one cron trigger, `0 * * * *`. Its
`scheduled()` handler runs `enqueueMaintenanceJobs`
(`packages/server/src/routing/scheduled.ts`), which refreshes tenant membership
in KV inline and sends selected jobs to `cupboard-maintenance`. The queue
consumer processes one message per invocation, with up to four concurrent
invocations. It retries a rejected message after 60 seconds and eventually moves
it to the dead-letter queue. Some tenant operations also continue on their own
alarm. Consequently, an hourly selection is not an hourly execution limit:
retries and alarm continuation can do more work between ticks, while delayed or
failed delivery can do less.

| Kind                      | Current trigger and work boundary                                                                                                          | Consequence                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offboarding drain         | An hourly selection takes at most ten tenants. Each message runs up to ten rounds of 1,000 rows per table and 1,000 tenant-prefix R2 keys. | Later tenants wait for selection; retries may repeat work. One million rows in one table need at least 100 selected messages, before latency or failures.           |
| Tenant maintenance        | The tick selects at most 100 due tenants by `last_maintained_at`; each message calls three RPCs.                                           | Deadlines are first noticed at tick resolution, then depend on queue delivery. Existing alarm continuations may advance GC between ticks.                           |
| Demote scans              | Each hourly message allocates one page of 500 shared rows per kind using a KV cursor.                                                      | A million-row rotation needs at least 2,000 page allocations under ordinary delivery; missing objects add tenant fan-out.                                           |
| Cache catalogue migration | The tick selects up to 100 tenants with a null catalogue marker; a message calls `initialise()` and can retry a pending migration.         | The object can continue bounded migration pages on its alarm. A tenant with an already-current local step and an incorrect marker still needs a recovery selection. |
| Shared-object reapers     | Two hourly messages start five phases that continue through new queue messages without a cap.                                              | Work from separate ticks can overlap, and an endlessly reporting phase can keep sending messages.                                                                   |
| Membership refresh        | The tick writes one KV marker per live tenant plus the filter before sending other work.                                                   | The hourly baseline exceeds Free's 1,000 KV writes a day at about 40 live tenants; a KV failure blocks that tick's other jobs.                                      |
| Control-key retirement    | The tick sends a job that selects every due key.                                                                                           | The selection and per-key loop have no structural page bound; failures leave due keys for later ticks.                                                              |
| Local-step wake           | The tick groups pending tenants into messages of twenty; the object continues on its alarm.                                                | This is the accepted pattern for tenant-local continuation.                                                                                                         |

The numerical page counts describe selection under ordinary delivery, not
completion-time or platform-capacity guarantees.

### The accepted pattern

Commits `0328288a4` and `81437a069` moved the local-step work onto the tenant
object's alarm. The properties that this document extends are:

- The control plane records overwritable facts per tenant in D1
  (`tenant.local_step_attempted_at`, `local_step_progressed_at`,
  `local_step_error`), derives its decisions from them (`localStep.status`
  classifies pending tenants as working, stalled or unwoken over a ten-minute
  window), and starts work with one message per twenty tenants.
- The object continues its own work on its alarm. A wake stores a request under
  `local-step:pending`, arms the alarm, and runs one page. A `local-step`
  maintenance pass runs further pages while the key is present: at once after a
  page that made progress, after `noProgressRetryMs` (30 seconds) otherwise.
  After `localStepStallWindowMs` (ten minutes) in which no page made progress,
  the run gives up, records why, and waits for the next wake.
- The object writes its own attempts, throttled to one progress write every 30
  seconds, and always on a stall, an error or completion. The consumer writes a
  fact only when the RPC rejected, conditioned on the attempt time that it read
  before the call.
- Every cron tick sends the same selection as the deploy's wake, so a lost
  message or an object that stopped is woken again.

The pieces that pattern uses already exist in
`packages/server/src/do/server.ts`: `maintenancePasses()` and
`runOneMaintenancePass`, `MaintenanceRetrySchedule`, `armAlarmNoLaterThan`,
`runExclusiveMaintenance`, and `LocalStepRun`
(`packages/server/src/do/local-step-run.ts`).

## Constraints

The maintainer has ruled out a coordinator and a control-plane Durable Object.
The design uses the existing pieces: the control Worker, D1, the maintenance
queue, cron triggers, and the tenant objects.

- Cloudflare Queues deliver at least once and concurrently. Every consumer in
  this document tolerates a duplicate and a concurrent delivery.
- D1 serialises individual statements, not a workflow across Worker calls. A
  conditional `UPDATE ... WHERE` or upsert supplies the compare-and-set. Every
  fact written here is a timestamp, a position, an identifier, an error text or
  a boolean; a write replaces the previous value, and a write that must not go
  backwards is conditioned on the stored value.
- A cron trigger fires at most once a minute. The trigger list is part of the
  operator's reviewed deploy plan and an existing deployment keeps its trigger
  across releases, so the design must be correct at any cadence and only its
  throughput may depend on the cadence.
- A Worker invocation has an internal-service subrequest allowance: 1,000 on
  Free and 10,000 by default on Paid, of which cupboard keeps 100 in reserve
  (`subrequestSafetyReserve`). External subrequests have a separate Free limit
  of 50. A queue consumer invocation ends after fifteen minutes of wall-clock
  time. See [Workers limits].
- A tenant object serialises its own work, has SQLite storage and one alarm.
  `setAlarm` overwrites the deadline. With this project's 2026-05-15
  compatibility date, `deleteAll()` also deletes the alarm [DO SQLite
  deleteAll]. A handler that throws is retried by the platform with backoff and
  then the alarm is dropped. See [Durable Object alarms]. The object's critical
  section is bounded at 25 seconds (`criticalSectionBudgetMs`), under the
  platform's 30-second `blockConcurrencyWhile` limit. The object binds D1, R2
  and the maintenance queue as a producer; it does not bind the KV namespaces.
- The Free plan's D1 allowance is 5 million rows read and 100,000 rows written
  per day, shared by every caller of the database, and D1 counts index
  maintenance as rows written. Once either allowance is reached, queries fail
  until midnight UTC. See [D1 pricing] and [D1 limits].
- The Free plan's KV allowance is 100,000 reads, 1,000 writes, 1,000 deletes and
  1,000 list requests per day. KV is eventually consistent: a value written in
  one location can take sixty seconds or more to be read elsewhere, and a list
  can omit a key written moments before. See [KV pricing] and [KV consistency].
- The Free plan's Queues allowance is 10,000 operations per day, and a delivered
  message costs about three (write, read, delete). The Paid plan includes one
  million operations a month. See [Queues pricing].
- Two project rules apply. Platform limits are enforced by a refusing wrapper at
  the binding, never by predictive arithmetic at call sites; the agreed
  follow-up derives the D1 per-invocation statement budget from a plan enum in a
  Wrangler variable. And the design uses plain names for repeated work:
  rotation, run, page, pass and refresh; the earlier term for a bounded pass
  over a table is not used, except where an existing message-kind identifier
  contains it.

[Workers limits]: https://developers.cloudflare.com/workers/platform/limits/
[Durable Object alarms]:
  https://developers.cloudflare.com/durable-objects/api/alarms/
[D1 pricing]: https://developers.cloudflare.com/d1/platform/pricing/
[D1 limits]: https://developers.cloudflare.com/d1/platform/limits/
[KV pricing]: https://developers.cloudflare.com/kv/platform/pricing/
[KV consistency]: https://developers.cloudflare.com/kv/concepts/how-kv-works/
[Queues pricing]: https://developers.cloudflare.com/queues/platform/pricing/
[DO lifecycle]:
  https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
[DO SQLite deleteAll]:
  https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#deleteall
[DO storage cleanup]:
  https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/

## Summary of the design

Tenant-local work uses each tenant object's alarm: offboarding drains its own
rows and R2 prefix, deadline maintenance runs on the alarm, and pending
catalogue migrations continue after any relevant entry point arms the alarm.
Paid periodic maintenance also uses the alarm; Free selects bounded groups on
the tick and each selected object runs its own periodic page. The control plane
finalises offboarding because it writes the registry tombstone and KV marker.

Shared work remains on the control plane. The tick sends independent bounded
messages for demote scans, each reaper phase, membership refresh and control-key
retirement. It reads facts and decides what is due; it performs none of these
jobs inline. Demotion has durable per-object and per-target work facts. No
control-plane message sends its own successor, and no coordinator or
control-plane Durable Object is introduced.

A small `reconciliation_run` table records outcomes and, on Free, an atomic UTC
slot admission fact. The latter caps elective background work even when queue
deliveries overlap. It does not guarantee the deployment-wide D1 allowance
against unbounded foreground traffic. `maintenance.status` and
`cupboard maintenance status` expose attempts, progress, failures, deferred work
and terminal cleanup from durable facts.

## Parts shared by every kind

### Protecting the Free plan's allowances

D1 has two separate limits on Free: 50 queries per Worker invocation and a
shared daily allowance of five million rows read and 100,000 rows written. A
query's `meta` reports rows read and written, including index work; the number
of logical rows selected is not a bound on those metrics. Both allowances
include foreground work and every background writer. [D1 limits] and [D1
pricing] describe the current platform contract.

The D1 binding wrapper charges statements before sending a call and refuses a
call that would exceed the plan's invocation allowance. Its budget belongs to
one Worker fetch, scheduled or queue dispatch, or one tenant-object HTTP, RPC or
alarm dispatch. Each dispatch creates one scope. Nested service calls reuse that
scope; the next dispatch gets a fresh one, even when the Durable Object instance
and its `ServerContext.d1` survive. The budget cannot be a mutable field on the
long-lived context or a separate counter for each Drizzle service. Use the
existing dispatch wrapper and async-local subrequest-slice pattern so
interleaved requests remain independent. A returned promise retains its scope
until the operation finishes. Tests must interleave two requests on one object,
invoke successive alarms and RPCs, and prove that nested services share one
allowance while later dispatches start at zero.

As a conservative project rule, charge each executable D1 statement, not each
binding call; Cloudflare documents a per-invocation query limit but does not
promise that a batch consumes only one query allowance. `prepare` and `bind` do
not spend the allowance; `run`, `all`, `first` and `raw` spend one. Reserve
every member of a `batch` before sending the atomic batch, so a refusal executes
none of them. Keep the existing refusal for `withSession` and `dump`; if a later
feature needs sessions, its statements and batches must join the same scope
before the refusal is removed. Disallow runtime `exec`, whose SQL string can
contain several statements, without trying to count semicolons. Allow only
`prepare`, `bind`, the four metered terminal methods and metered `batch`; refuse
any future binding query method until the wrapper explicitly accounts for it.
Migration tooling can use its separate explicit executor. Preserve the current
binding's deadline and subrequest accounting. Page loops reserve statements for
their outcome writes. A refusal leaves the next page for a later invocation.

Use the existing `WorkersPlanTier` and deploy's account-plan decision to write
one `free` or `paid` variable to both Worker scripts in the reviewed deployment
plan, alongside `CUPBOARD_SUBREQUESTS_PER_INVOCATION`. An older deployment with
no plan variable uses the Free statement limit. An invalid value also uses the
Free limit and records a configuration error; deploy validation rejects an
invalid generated value before upload. This is a plan-derived safety policy, not
an operator page-size control. Free permits 50 D1 queries per invocation; Paid
permits 1,000. Test direct Wrangler deployment with a missing or invalid
variable, a plan change, both script configurations, a mixed-version deploy and
rollback. The wrapper does not enforce the shared daily rows allowance.

On Free, elective work therefore uses a fixed, deployment-wide admission
schedule. A `reconciliation_run` fact `last_admitted_slot` records the UTC slot
most recently admitted for each kind, including the one shared `offboard-rows`
kind. A single conditional D1 upsert advances the slot only when the stored slot
precedes the requested one. Duplicate messages and concurrent objects for the
same slot can therefore perform at most one unit. A slot is consumed **before**
any page can write rows. An interruption or partial failure wastes the slot and
leaves the remaining rows for the next one; it cannot start another deletion
page after 30 seconds. This is an admission fact, not ownership of a tenant or
an expiring lease. The tick's interval remains advisory; the conditional update
is the hard limit. Use a bounded, fixed number of UTC slots per kind, not a
sliding comparison with a recent attempt. The Free offboard candidate is the
incomplete row part with the oldest recorded row attempt, with tenant id as a
tie-breaker. The object checks that selection before attempting the atomic slot
admission, then records its row attempt before deleting. A failed tenant returns
behind other attempted tenants on later slots; a duplicate or concurrent
candidate can spend only one slot. If an invocation stops after admission but
before its attempt fact, the same candidate may be retried in the next slot.
That rare interruption can delay others, and status exposes the admitted slot
without a matching attempt. Object deletion and finalisation do not depend on
this selection.

Each admitted unit also has a maximum statement count, selected row count, R2
call count and elapsed-time budget. All SQL operations that can change an
unbounded number of rows must first select a bounded key page and mutate only
those keys. For the exact migration schema, derive a conservative per-unit
ceiling from the bounded SQL and indexes, then check D1 `meta` for full pages,
empty pages, indexed deletes, facts, retry paths and each reaper phase. A
measured maximum alone is not a mathematical bound on future populations. If a
query can scan or mutate beyond its declared ceiling, change the query or keep
that Free unit disabled. Set page sizes and slot frequencies only after this
check. Keep the Free row drain and new higher-frequency control work disabled
until the admission test passes.

The Free release policy reserves at least half of each D1 daily row allowance
for foreground and deadline work: planned elective background work may use at
most 2.5 million rows read and 50,000 rows written per UTC day. This is a
conservative internal release gate, not a promise that foreground traffic cannot
exhaust its remaining half. Start with one admitted row page across all
offboarding tenants per UTC hour, one unit per reaper phase and demote kind per
hour, and the hourly membership and control-key units described below. The
initial release targets at most 500 total row keys across the four offboarding
tables in one unit, 500 shared objects in one demote page, 25 keys in one reaper
page and 100 tenants in one periodic selection. Those are caps on selected keys,
not assertions about D1 rows scanned or billed. Use one deterministic
release-sizing rule: test the target vector `(500, 500, 25, 100)` in that order,
then halve all four caps together and round down to at least one key until the
complete daily worksheet passes. Choose the first passing vector. Do not change
a slot frequency or disable one kind to make the calculation pass. Its
predecessor path must also be bounded. These are release constants derived from
repeatable tests, not operator settings. Increase a released cap only with new
fixture and hosted evidence. At 500 offboard rows per hour, a million rows need
at least 2,000 admitted hours on Free; at 250 rows, at least 4,000 hours. If the
measured cap is smaller, publish its resulting minimum page count. This excludes
retries and R2 work, so large drains need Paid capacity for shorter completion
times.

The admission test uses an explicit daily worksheet. For reads and writes
separately, add the maximum number of UTC slots per kind multiplied by the
validated ceiling for one unit. Include tick selections, membership repair,
finalisation, retries, outcome and index writes, and one maximum partial unit
per kind at a UTC boundary. Free periodic integrity has one deployment-wide
selection of at most `P` tenants per hour, where `P` is the selected fourth
release cap, at most 100. Its worksheet term includes at most `24 × P` selected
tenant pages in the current UTC day and one prior-hour group of `P` pages that
can finish after midnight, plus the selection, dispatch, heartbeat, projection
and error costs of those pages. This is a planned issue-time bound: an abandoned
external D1 call can finish later, so hosted billing within one UTC day has no
proven absolute bound. A late queue delivery cannot execute a previous hour's
group. Include empty selections even when no tenant is due. Use the indexed
query and mutation bounds proved at 5, 200 and 5,000 tenants; do not extrapolate
an unbounded scan from these fixtures. Publish the measured fleet envelope and
minimum full-rotation time for the selected caps, without imposing a
tenant-creation restriction based on this elective schedule. If even the one-key
vector fails the complete worksheet, the new Free elective profile cannot
activate; keep the bounded compatibility schedule, report the unavailable
profile in status, and require a revised profile or Paid capacity. Recheck the
worksheet after a schema or page-size change. No finite background schedule
guarantees that the total deployment stays below Free's daily allowance if
foreground requests or deadline work are unbounded. When daily usage is near the
allowance, D1 can reject both background and foreground queries; status must
report that platform error.

D1 analytics are useful for diagnosis, but the documented API gives no freshness
bound suitable for page admission. A sample that is missing, stale, or from a
previous UTC day never authorises extra work. The fixed slot and unit limits
remain in force even if the tick stores observed usage. Do not replace them with
a threshold check until an independently proved maximum expenditure between
observations, including concurrent work, exists.

[D1 analytics]:
  https://developers.cloudflare.com/d1/observability/metrics-analytics/

### The `reconciliation_run` table

One D1 row per control-plane kind records overwritable observations. The Free
admission fact above is also stored here. Each write uses a conditional
comparison so an older consumer cannot replace a newer timestamp. An error and
its timestamp change together. Success in one run does not erase an unrelated or
later failure.

| Column                                                                 | Meaning                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                                                 | Primary key for each reaper, demote rotation, membership refresh, control-key retirement, Free periodic selection, shared `offboard-rows` admission and terminal residue check. |
| `attempted_at`                                                         | Last observed start.                                                                                                                                                            |
| `progressed_at`                                                        | Last observed durable change or completed page.                                                                                                                                 |
| `completed_at`                                                         | Last run that checked its bounded part. For a demote rotation, every page has a durable result, which can include pending probe or repair work.                                 |
| `left_work_at`                                                         | Last run that reported unfinished work because of a budget, deadline or deferred unit.                                                                                          |
| `error`, `error_at`                                                    | Latest observed failure, updated as one conditional write.                                                                                                                      |
| `last_admitted_slot`                                                   | Last Free UTC work slot admitted through a conditional update. It is not a lease.                                                                                               |
| `selection_id`                                                         | Random identity for a Free periodic tenant selection. A losing concurrent producer cannot assign another group for that slot.                                                   |
| `rotation`, `position`, `rotation_started_at`, `rotation_exhausted_at` | Demote page progress. `rotation_exhausted_at` is set only after the last page has been checked and its missing-object or failed-probe facts are durable.                        |

An attempt write must preserve a newer error and vice versa. The status API
compares timestamps and states which facts were observed; it does not infer that
a queue message was lost from an old `attempted_at`. Rotation advancement and
Free slot admission use conditional writes; neither grants exclusive ownership
of a tenant. A typed helper receives structured outcomes from the reaper and
demote services so caught partial failures reach these rows.

### The tick as a decision over facts

`enqueueMaintenanceJobs` reads the run facts, makes bounded tenant selections,
and sends messages. A kind is due when its last observed attempt is absent or
older than its interval. On Free, the consumer's atomic UTC slot admission also
caps actual work when duplicate or overlapping ticks send more messages. The
schedule only sets how soon the tick can notice work; it does not guarantee an
hourly execution count.

The release defaults are hourly selection on Free and five-minute selection on
Paid after the phase consumers are active. Free admits one bounded unit per kind
and UTC hour. Paid sends one message per reaper phase and up to twelve demote
page messages per kind at each tick, while each invocation still has statement,
subrequest and time limits. Control-key retirement is checked on every tick,
with a Free admission slot. The deploy plan already reviews cron triggers; the
new cadence is a deliberate change to both configuration and deployed trigger,
not an assumption that a code upload rewrites an existing trigger. These
defaults are not completion-time guarantees. The Paid cadence is limited by
observed D1 latency and queue health during rollout, not by the included Queues
billing allowance.

The tenant selections include pending local-step or catalogue work, offboarding
starts and finalisation, Free periodic work, and maintenance recovery. Each
selection has a result cap. The local-step upgrade can still read a large
pending set and send one message per twenty tenants, so the tick's cost is not
constant. At 5,000 selected tenants that fan-out is 250 messages. Bounded
results do not imply bounded D1 rows read; measure the query plans and `meta`
for empty and full selections before narrowing the old backstop.

### Attempt facts on the tenant row

Keep the existing `LocalStepRun` behaviour. Offboarding has two distinct parts
and terminal finalisation, so its outcome writer is specific to those facts
rather than a generalised `PagedRun` class. Both use the shared scheduler's
`deferred` outcome for an intentional future deadline. A no-progress retry or
error has a separate stall deadline. Successful progress in one offboard part
cannot clear an error in the other.

### The scheduler's outcome contract

A maintenance pass returns `MaintenanceProgress`, today `'progressed'` or
`'stalled'`, and `recordMaintenanceProgress` writes a retry deadline of 30
seconds for a stall. A pass cannot set a longer deadline itself, because the
scheduler overwrites it. The contract gains a third outcome,
`{ kind: 'deferred', until: number }`: the pass has work but must not run before
`until`. `MaintenanceRetrySchedule.record` stores that time as the pass's retry
deadline, and `maintenancePassDueAt` and `armForMaintenancePasses` already
honour retry deadlines, so a deferred pass arms the alarm for `until` and
nothing earlier. A pass that has given up returns `deferred` with `until` one
hour ahead.

### `maintenance.status` and `cupboard maintenance status`

A contract-first, replay-safe `maintenance.status` procedure uses
`GET /control/maintenance` and a new deployment-wide `maintenance:read` grant.
Add that operation to the bootstrap operator grant and test that a token without
it is refused. The CLI command `cupboard maintenance status <url>` presents the
same typed response in the style of `cupboard deployment status`, with the
ordinary reporter's JSON and terminal modes. The default response includes one
section per kind, durable run facts and at most twenty affected tenant or object
samples per section. Samples use stable keyset order. An optional `kind` and
validated keyset cursor request the next twenty entries of that kind, as the
existing cache and root listings do. Bind the cursor to its kind and filters,
and use it only as a SQL parameter. Each page has a bounded statement count;
each returned error summary is at most 500 characters. Exact pending counts are
included only for indexed queries whose measured cost fits the status budget;
otherwise the response reports `count unavailable` and whether another page
exists. The status procedure never enumerates the full backlog in one
invocation. Test sparse, full and empty pages at 5, 200 and 5,000 tenants,
including D1 `rows_read` and the Free statement limit.

Each section identifies which flags can overlap and which state is exclusive. A
recent success does not erase a later error from another pass. `deferred` means
an intentional future retry time, while `stalled` means repeated failure or no
progress. A missing attempt shows that none was recorded; it does not establish
that the tick, queue or alarm failed. Store and return bounded error summaries
with a stable category, observation time and request identifier. Return the
known D1 quota and overload codes, but do not expose arbitrary exception text,
SQL, credentials, URLs or token material. Detailed causes remain in protected
logs. The operator guide can use this procedure instead of a manual query of
`tenant_maintenance_failure`.

## 1. The offboarding drain

### Current behaviour and placement

`controlTenantOffboard` changes the registry status and calls `beginOffboard()`.
The object currently sets only an in-memory fence. The hourly consumer calls
`runOffboard()`, deletes rows from four D1 tables, deletes R2 keys under
`t/<tenant>/`, purges the object, writes the tombstone, and deletes its KV
marker. An interruption between these steps is recoverable only through another
tick. The object is the single writer of its references and presence rows, so it
should drain them on its alarm. The control plane writes the tombstone and KV
marker.

The `t/<tenant>/` prefix contains tenant-local narinfo and attestation objects.
NAR and CAS bytes use shared `nar/` and `cas/` keys. Removing a tenant's prefix
does not remove those shared bytes. The global reapers collect a shared object
only when its reference and incarnation rules permit it.

### Durable facts and invariants

The tenant row gains conditional, monotonic attempt and progress timestamps for
each of the row and object parts, a completion timestamp for each part, and a
separate error and error time for each part and finalisation. It also records
`offboard_drained_at` after both parts have been checked empty,
`offboard_marker_deleted_at` after the KV delete succeeds, and a due time and
last result for terminal residue checks. The tombstone keeps these facts,
including a finalisation error that occurs after tombstoning. Success in one
part does not clear another part's error. Status compares each error time with
that part's later progress or completion.

Object storage gains `offboard:begun`, `offboard:pending`, `offboard:rows-done`,
`offboard:objects-done`, and separate retry deadlines for the two parts. The
Free row pace is the control D1 admission fact
`offboard-rows.last_admitted_slot`, written before any deletion. A failed or
interrupted page has used that slot. No `row-page-at` write after deletion is
needed. The pending marker remains until both parts are finished; an empty
object part cannot stop a deliberately deferred row part.

The required lifecycle invariant is stronger than filtering
`maintenancePasses()`: once `offboard:begun` is durable, no entry point may
admit a new ordinary mutation. Guarded D1 statements prevent a late reference or
presence insert after the registry changes status. An R2 put issued before the
fence may still finish later; terminal residue repair removes its tenant-prefix
bytes. The object restores the fence before dispatching work after eviction, and
checks the authoritative D1 registry status when local identity has been purged.
`beginOffboard()` closes commit sockets and makes their later callbacks observe
the fence. A shared object-local lifecycle gate admits the whole mutation,
including asynchronous D1 and R2 calls and trailing bookkeeping, before it
starts. The gate covers HTTP routes, alarms, cache teardown, verification,
maintenance and demotion RPCs, upload settlement and direct helper RPCs. It
rejects new ordinary writers after the fence. Nested helpers reuse their entry
rather than waiting on themselves. The existing per-kind maintenance locks do
not provide this gate. Read-only requests continue according to registry
admission policy.

Admission does not add a persisted row per foreground mutation. The durable
fence is the recovery fact; the gate counts active operations only in the live
object. A bounded D1 or R2 call that times out may still complete, as
`ObjectWriteOrder` already recognises for path-keyed R2 writes. The lifecycle
gate therefore keeps that operation active until its underlying settlement
signal completes, even if the client has already received a timeout. In
particular, a late `t/<tenant>/` put cannot pass a terminal residue check merely
because the wrapper returned. Shared content-addressed `nar/` and `cas/` writes
may finish after the fence, but they cannot create a tenant reference; the
global reapers collect unreferenced bytes. The implementation audit must
enumerate all D1 reference and presence writes and all tenant-prefix R2 puts,
deletes and moves, including migration paths and callbacks.

The four D1 reference and presence inserts need a second fence at the database
statement itself. The current NAR charge batch and attestation reference batch
already use `INSERT ... SELECT` from a tenant whose status is `active`, in the
same atomic D1 batch as their usage changes. Preserve that predicate and require
it for every later insert or update that could recreate these rows. A status
read before an awaited call cannot replace the statement predicate: an old batch
may execute after offboarding begins or after an object reset. Test a batch
paused before D1 execution, transition the tenant to `offboarding`, then release
it and assert that no reference, presence, usage or reaper-state change occurs.
Keep the existing five-statement charge batches within the invocation budget; a
newly found writer must account for its added guarded statements and index rows
in the Free worksheet.

### Drain and terminal protocol

The control operation changes the tenant to `offboarding`, calls an updated
`beginOffboard()` that closes gate admission, persists the fence, closes commit
sockets, and sends one start message. The fence is written only after the
object's identity or migration journal is established; an unconfigured object
must not acquire a lone key that makes it appear configured. A failed start
remains visible and the tick retries it. A pending local or catalogue migration
makes `startOffboard()` arm the migration alarm and return incomplete. The
offboard passes become eligible when initialisation finishes.

Each alarm runs at most one bounded part page, then records that part's attempt
and outcome before scheduling the next alarm. The object part lists and deletes
at most one bounded page under `t/<tenant>/`, restarting the listing at the
prefix. The row part selects and deletes bounded pages from `blob_ref`,
`attestation_ref`, `tenant_blob` and `tenant_cas_blob` through the existing
single writer. On Free it first checks that this is the oldest-attempt
offboarding tenant whose row part remains and conditionally admits the current
UTC row slot. The shared slot comparison serialises competing alarms. Paid uses
the per-invocation statement and time budgets without daily slot pacing. The
selected row page size is a fixed implementation constant. The proposed 500-key
cap requires D1 metadata, index and 25-second critical-section tests before Free
activation; it is not a promised safe size.

When a part finds no residue, it records that part as done and stops scheduling
that pass. The other pass continues independently. A no-progress object page
retries after 30 seconds. On Free, a failed row page records its error and waits
for the next UTC slot because the current slot was spent before deletion; on
Paid it may retry after 30 seconds. A persistent fault defers only the failing
part for an hour. A planned Free slot wait is `deferred`, never a stall. When
both parts are done, the object checks all four D1 tables with bounded `LIMIT 1`
queries and lists one key under the tenant prefix. Only the empty result writes
`offboard_drained_at` and sends a finalisation message. The tick also selects
drained tenants, so a failed send does not strand finalisation.

`finishOffboard()` closes gate admission and waits outside
`blockConcurrencyWhile` for active writers and underlying timed-out calls. The
wait has a short invocation deadline; expiry returns `waiting-for-writers` and
schedules a retry without purging storage. A client conversation or a stuck R2
call never occupies the object's 25-second critical section. Once the gate is
quiet, the object rechecks the four tables and R2 prefix. Residue returns
`not-drained`; the control consumer conditionally clears the drained fact and
reopens the incomplete part. The control consumer then conditionally writes the
D1 tombstone before the short local-storage purge. Tombstoning first keeps the
registry refusal in force if the object resets during purge. A retryable purge
deletes the alarm and local storage under the short critical section; the fenced
in-memory object rejects later entries. The KV marker delete and its completion
fact follow, with independent retry. A tombstoned object whose purge failed
remains fenced and is retried. None of these steps waits under the critical
section for an external D1, R2 or client operation.

Forced reset can discard the in-memory operation set while an already-issued
external call is still in flight. Cloudflare keeps a normal object active for
pending I/O, but it does not offer a durable settlement receipt for an R2 or D1
call after a forced reset [DO lifecycle]. An empty prefix at one instant is
therefore not proof that a late put cannot finish. The tombstone makes logical
retirement final: entry points reject writes, and an old request cannot make the
tenant readable again. Keep a bounded, recurring terminal-residue selection over
tombstoned tenants. It checks the four D1 tables and `t/<tenant>/`, removes
residue through exact bounded keys while the tombstone excludes active writers,
and records the check, any repair and errors. A failed or nonempty check becomes
due sooner; otherwise the tenant returns to a slower periodic rotation. The
selection uses due time and tenant id so older tombstones do not starve. On
Free, a separate atomic `offboard-terminal` UTC slot admits at most ten
tombstones per hour, and each tenant gets one bounded 25-key residue page. Paid
selects at most ten due tombstones per five-minute tick. A nonempty page becomes
due again at the next eligible slot; an empty page becomes due again after 24
hours on Paid or seven days on Free. Thus every tombstone is revisited under
sustained service, though a large backlog has no fixed completion time. A
physical-cleanup status reports the last clean observation, not a permanent
proof that R2 is empty. The Free admission worksheet includes this rotation.

An `offboarding` row with an unconfigured object may be an interrupted legacy
purge. The consumer checks the four tables and R2 prefix. If both are empty, it
records the drained fact and proceeds to tombstone and marker cleanup. If either
contains residue, it records a terminal recovery error and leaves the tenant
offboarding for operator repair. It never deletes an edge without the tenant
writer while the registry still says `offboarding`. Once the registry says
`offboarded`, the terminal-residue job may remove exact residual keys because
the durable tombstone excludes an active tenant writer. A tombstone with a
remaining marker is selected by membership cleanup.

### Free admission and capacity

Only one Free row page is admitted in each configured UTC slot across the whole
deployment. The candidate check and atomic slot update avoid the race in a
read-then-start gate; a second tenant cannot use the same slot. After an early
delete commits and a later table fails, the slot stays consumed. The aggregate
worksheet in the shared budget section includes full and partial pages, index
writes, four-table residue reads, attempt facts, terminal facts and retries. It
also includes the independent reaper and maintenance work. Until those costs are
measured and the restricted schedule is set, Free automatic row draining is not
enabled by this design. A fixed schedule can cap elective background cost but
cannot reserve unused D1 allowance against arbitrary foreground traffic.

Paid tenants have independent objects, but all row pages share one D1 database.
Cloudflare states that one D1 database processes queries serially and can return
overload errors. The time to drain a million rows or objects therefore needs a
representative measurement under concurrent drains; the page count alone is not
a completion bound.

### Status and recovery tests

Status distinguishes `waiting for Free slot`, `waiting for writers`,
`draining rows`, `draining objects`, `awaiting finalisation`,
`finalisation failed`, `terminal recovery needed`, `marker cleanup pending` and
`terminal residue observed` from durable facts. It reports the next eligible
slot when deferred. It does not call a three-hour scheduled wait a stall, and it
keeps row and object errors independently. A recent start shows an observed
start, not proof that the queue or alarm will finish.

Tests cover duplicate starts and finalisations, partial row failure after a
committed delete, concurrent Free admission by two objects, an object part that
finishes hours before rows, an evicted object that restores the fence, commit
sockets and every direct writer racing the fence, trailing alarm bookkeeping
racing purge, a terminal residue recheck, an unconfigured object with and
without residue, a failed marker delete after the tombstone, and shared `nar/`
and `cas/` bytes remaining for the global reaper.

## 2. Tenant maintenance

### Current behaviour and placement

The tick selects at most 100 active tenants whose eligibility projection is
missing, old or due. The consumer calls garbage collection, verification and
auth-key retirement as separate RPCs. The object already continues some work on
its alarm, but no alarm is armed for the projected deadline. The projection uses
the Unix epoch for immediate work and deliberately leaves `reconciled_at`
unchanged when its deadline has not changed. Neither value is a heartbeat.
Deadline work runs on the tenant object's alarm. A Paid object also schedules
its own six-hour periodic check. On Free, the tick selects objects for a bounded
periodic check that becomes due after 24 hours; the check still runs in the
object. The tick remains a recovery backstop. The existing PLAN.md preference
for cron garbage collection must change with this release.

### Facts and alarm work

Keep `tenant_maintenance_eligibility.next_wake_at` as the deadline projection,
including the epoch sentinel. Add `tenant.maintenance_heartbeat_at` for the last
completed object pass or periodic check. Add
`tenant.maintenance_projection_missing_at`, set before or atomically with
removal of a failed projection and cleared after a successful reconciliation. A
null projection with no marker in upgraded persisted state is marked by a
bounded backfill before the old selection is narrowed. An unbounded data
migration would consume Free D1 writes. These are distinct facts: a deadline is
not evidence that a handler ran, and a recent heartbeat does not make a missing
projection healthy.

For Free periodic selection, add `tenant.periodic_next_due_at` with an epoch
default for existing tenants, `periodic_selected_slot`, `periodic_selection_id`
and `periodic_checked_at`. These are due, admission and outcome facts, not a
count of work performed. Index active tenants by due time and id. A selection
that gets no queue delivery remains due after the next hour and eventually
returns to the front of the fair due order. A completed page sets the next due
time 24 hours ahead; a failed or interrupted page keeps an earlier due time.

The object records one `tenant_maintenance_failure` row per pass:
`garbage-collection`, `verification`, `auth-key-retirement`,
`managed-retirement` and `periodic-check`. Failed and successful times are
conditional and monotonic; a successful pass does not clear another pass's
failure. Stop incrementing `consecutive_failures` only after predecessor
compatibility has been tested, and retain the column for the rollback window.

The alarm rotation gives garbage collection, verification, auth-key retirement
and managed retirement separate turns, subrequest slices, retry deadlines and
failure rows. Paid also includes the periodic check in that rotation. Each pass
reads its own effective deadline. Garbage collection keeps its continuation.
Verification processes a bounded pending page and requests `tenant-verify` when
uploads remain. The periodic check runs one integrity page and reconciles the
projection. It becomes due after 24 hours on Free or six hours on Paid. The Free
object's alarm never admits that elective page: only the selected periodic RPC
may do so, after it validates the durable assignment and current UTC hour.
Deadline work remains eligible immediately on both plans. On Paid, derive a
stable phase offset from the tenant id when first arming an upgraded idle
object, so 5,000 existing objects do not all start their periodic check in one
interval. An error or page with no progress records a failure, retries after the
pass's backoff, then defers for an hour after its stall window. The scheduler's
outcome type gains `{ kind: 'deferred', until }`, so it cannot replace the
pass's longer deadline with the generic 30-second retry.

`reconcileMaintenanceEligibility()` arms the earliest **effective** alarm pass
deadline, after applying retry deadlines. On Paid, creation, first
initialisation and each backstop wake also arm the periodic pass when its local
key is absent. On Free, the periodic selector wakes idle objects while the alarm
continues to schedule deadline work. The old broad backstop remains until every
active tenant has been observed with a new-build heartbeat; it may stay longer
if its measured query cost fits. Merely waiting one interval does not cover a
fleet larger than one tick's selection.

### Free periodic admission

The Free tick admits one deployment-wide `tenant-periodic` selection per UTC
hour. It first reads at most `P` active tenants, using the selected release cap,
ordered by `periodic_next_due_at, id`, where the due time is no later than the
current hour. A transactional D1 batch conditionally advances
`reconciliation_run.last_admitted_slot` and writes a fresh `selection_id`, then
assigns that slot and identity to the selected tenants. Bind the selected ids as
one JSON array through the repository's `json_each` list pattern, then test the
full target 100-tenant batch against D1's parameter limit and row metadata. The
assignment statement is conditional on the batch's stored `selection_id`; if a
competing tick won admission, this batch assigns no tenant. It also sets each
assigned tenant's next due time to the next UTC hour. The winner reads back only
its assigned ids and sends them in existing groups of twenty. The queue's
one-message-per-invocation configuration, these groups and the binding-level
budgets keep dispatches bounded. A send failure leaves the assignment visible;
the tenant becomes due again after the hour and fair due ordering eventually
reselects it. A duplicate tick cannot assign a second group for the same hour.

The consumer and object reject a periodic message outside its assigned UTC hour.
The object reads its tenant's D1 assignment and active status, compares both the
hour and `selection_id` with the message, validates the current hour again
immediately before its local claim, and conditionally records
`periodic:last_executed_slot` in one atomic local SQLite critical section before
the page starts. A duplicate message, alarm or direct RPC cannot start another
page for that assignment. Free alarms never schedule the periodic pass without
an assigned message. A forced reset restores the executed-slot fact from local
storage. A failure before that fact is written can retry within the hour; a
failure afterward waits for another admitted selection. An object that starts
near the hour's end may finish after midnight. The periodic RPC has a fixed
cooperative deadline of at most 25 seconds, so only the previous hour's group
can cross a UTC-day boundary; the worksheet includes that group. A delayed
message from an older hour is rejected and does not consume a new page.

On success, the object conditionally records `periodic_checked_at`, a heartbeat
and `periodic_next_due_at` 24 hours ahead, using its still-current assignment
slot and identity as the update predicate. A stale completion cannot overwrite a
later assignment. A failed page records its pass-specific error but leaves the
next due time no later than the following hour. Deadline GC, verification and
key retirement do not use this elective slot and remain eligible on their
alarms. The Free periodic schedule is fair best-effort: with 5,000 due tenants
and `P` assignments per hour, one visit needs at least `ceil(5,000 / P)` hourly
selections, before queue delay, failure or retries. Status reports the oldest
due time and last completed page; it does not promise a 24-hour full-fleet
rotation.

### Backstop selection and cost

The backstop selects the union of the first two predicates on Free and all three
on Paid for active tenants:

1. `maintenance_projection_missing_at IS NOT NULL`, regardless of heartbeat;
2. a due `next_wake_at` older than ten minutes and no heartbeat in those ten
   minutes;
3. on Paid, no heartbeat in seven hours, including a null heartbeat.

The epoch sentinel is therefore not selected while an object has reacted within
ten minutes. A heartbeat that is six hours old does not suppress an epoch wake:
predicate 2 selects it. The missing-projection predicate remains independently
sufficient even after a recent successful pass.

Use these bounded SQL selections. Run the third only on Paid, deduplicate the
selected tenant ids, then apply `backstopTenantsPerTick` to the result. The
consumer must stamp `last_maintained_at` after each attempted wake, including a
rejected RPC, as it does today; otherwise a persistently failing first page
could starve later tenants:

```sql
SELECT id FROM tenant
WHERE status = 'active'
  AND maintenance_projection_missing_at IS NOT NULL
ORDER BY last_maintained_at, id LIMIT :cap;

SELECT e.tenant FROM tenant_maintenance_eligibility AS e
JOIN tenant AS t ON t.id = e.tenant
WHERE t.status = 'active' AND e.next_wake_at <= :ten_minutes_ago
  AND (t.maintenance_heartbeat_at IS NULL
       OR t.maintenance_heartbeat_at <= :ten_minutes_ago)
ORDER BY t.last_maintained_at, e.tenant LIMIT :cap;

-- Paid only
SELECT id FROM tenant
WHERE status = 'active'
  AND (maintenance_heartbeat_at IS NULL
       OR maintenance_heartbeat_at <= :stale_cutoff)
ORDER BY last_maintained_at, id LIMIT :cap;
```

The due branch can begin at
`tenant_maintenance_eligibility(next_wake_at, tenant)` and join the tenant row;
the stale and missing branches can use partial active-tenant indexes on
`maintenance_heartbeat_at` and `maintenance_projection_missing_at`. Ordering by
`last_maintained_at` may still require a temporary sort or a wider scan. The
Free periodic selection needs its own indexed due-time path. Do not claim that
`(pass, last_success_at)` covers tenant identity or that the queries examine
only their returned rows. Before narrowing the backstop, run
`EXPLAIN QUERY PLAN` on each branch and D1 `meta.rows_read` on empty, sparse and
fleet-wide due fixtures at 5, 200 and 5,000 tenants. If an empty selection scans
the fleet each tick, retain the old cadence or change the projection/index
before activation. Selection and queue costs enter the Free read and write
worksheet.

### Status and failure cases

Status reports independent flags `projection missing`, `deadline overdue`,
`heartbeat stale`, `periodic overdue` and `pass failing`, with bounded samples
and the relevant timestamps. The flags may overlap. A recently successful
periodic check does not erase a GC failure. A projection deleted during a D1
fault remains eligible through its missing marker when D1 returns. A lost or
dead-lettered backstop message remains eligible at the next tick. A reset object
recomputes its effective deadlines from persistent state and rearms its alarm.

On Paid, a six-hour period at 5, 200 and 5,000 tenants implies averages of about
0.83, 33.3 and 833.3 periodic alarms an hour. Stable phase offsets reduce the
ordinary burst; deploy and recovery can still produce one. Free admits at most
`P` periodic tenant pages per hour, or `24 × P` selected pages in a UTC day,
plus up to `P` pages that began in the previous hour. At 5,000 tenants, one
visit to each tenant needs at least `ceil(5,000 / P)` hourly selections. Include
the assigned-tenant updates, heartbeat and projection writes, pass outcomes,
queue dispatches, retries and index work in the half-allowance worksheet. With
the existing 100-tenant backstop selection cap, visiting 5,000 eligible tenants
takes at least fifty selections, excluding detection, queue delay, retries and
failures. These are minimum scheduling counts, not recovery bounds.

## 3. The demote scans

### Current behaviour and coverage

The control plane scans shared `blob_state` and `cas_object` rows because one
missing object may affect several tenants. Today a KV cursor advances before the
page is processed. NAR demotion leaves `blob_ref` edges in place, so a restarted
unbounded fan-out can repeat its first targets indefinitely. CAS demotion calls
`removeReferencesForDigest()`, which reads and processes every reference for one
tenant and digest. A batch of digests does not bound that inner operation. Both
paths need bounded target work, not merely bounded scan pages.

The rotation is an audit of a changing table, not a snapshot transaction. Its
cursor advances only after every object in a bounded page has either a
successful HEAD result with any missing-object work recorded, or a durable retry
fact for a failed HEAD. A crash before that update repeats the page, so a
transient failure cannot permanently skip it. A persistent failure remains
visible without blocking later pages. A new or changed row behind the cursor can
still wait for the next rotation. Repair of recorded work continues
independently of later rotations.

### Rotation and pending work facts

`reconciliation_run` stores a random rotation id, its keyset position,
`rotation_started_at` and `rotation_exhausted_at`. A consumer reads one bounded
page at that position, checks its objects and durably inserts each
missing-object observation or failed-probe retry, then conditionally advances
the cursor on the rotation id and old position. A losing concurrent consumer may
repeat those checks, but its cursor write changes nothing. A failed D1 recording
leaves the cursor unchanged for retry. A failed R2 HEAD creates an
`object_demotion` row in `probe-pending` phase, without treating the object as
missing. Its retry uses a bounded backoff and the same incarnation fence; a
later successful HEAD removes the probe fact or changes it to `discovering` if
the object is absent. A permanently failing probe stays due at its next retry
time while the rotation continues. The final short or empty page records
`rotation_exhausted_at` after this work; `completed_at` means that every page
produced either an observation or a durable retry fact. Status separately
reports pending probes and never calls that rotation clean while they remain.
Later messages acknowledge while exhausted. A new rotation starts only after the
interval from exhaustion, with a new id and empty position. An empty first page
completes once, without repeated wraparound. Status distinguishes completion of
this best-effort rotation from proof of a consistent snapshot.

`object_demotion` has one row per missing object or failed probe and
incarnation. It records its kind, first observation, phase (`probe-pending`,
`discovering`, `routing`, `checking`), keyset reference cursor, next attempt
time, last attempt and error. A failed probe retries after 30 seconds, with
exponential backoff capped at one hour; the Free UTC slot still limits admitted
probes. A new failed probe must not change a row that has already progressed
beyond `probe-pending` back to that phase. A successful HEAD removes only its
probe fact when the object is present; missing-object work already in progress
remains subject to its own reference and incarnation fences.
`object_demotion_target` records one exact reference identity under that object
and incarnation, with a `done_at` fact. The target identity uses the columns of
`blob_ref` or `attestation_ref`, including tenant, cache kind, cache name, path,
generation and predicate where applicable. No target row is removed merely
because a message failed. A later promotion uses a different incarnation and is
independent of this work.

A bounded reference query after the object's durable cursor inserts a bounded
set of target rows before moving the cursor. Discovery pages use keyset ordering
over the reference table's full identity and an index beginning with the object
id. Route pages select `done_at IS NULL` targets in primary-key order, up to the
invocation's remaining statement, subrequest and time budget. Each successful
tenant RPC marks only its exact targets done. A failed RPC updates the object
row's error and `next_attempt_at`; other pending objects remain eligible.
Selection orders due objects by `next_attempt_at`, then `first_seen_at` and
object id, with a bounded number per message. A persistent failure gets a later
attempt time so it cannot monopolise every message.

NAR target RPCs are small because `demoteUnbackedLocked()` can read D1 once per
target. CAS receives a new bounded per-reference RPC; it rechecks the fenced R2
object and removes only the exact captured reference through the tenant's
existing single-writer path. It must not call the current
`removeReferencesForDigest()` over an unbounded set. Compute the Free maximum
RPC target count from the receiver's 50-query allowance, reserving its own
initialisation and outcome calls, and test actual generated statement counts. A
proposed count of 100 targets is not safe by itself.

After all recorded targets are done, the checking phase searches for current
references that have no completed target fact. A bounded page of such references
returns to routing. The final fenced shared-row delete must include an atomic
`NOT EXISTS` condition for unmatched current references, in addition to the
existing incarnation fence. A concurrent new reference therefore prevents the
old incarnation's deletion and is inserted on a later check. If the shared row
has already changed incarnation, retire this work row and its target facts
without touching the new object. Delete completed target facts in bounded
batches after the fenced row transition; failed cleanup is retryable. Validate
the anti-join's index and rows-read cost on a high-fan-out fixture before
activation.

Each message reserves a bounded part of its budget for due pending objects,
including failed probes, and a separate part for one scan page. A large pending
set cannot stop rotations, and an empty scan cannot stop pending repair. On
Free, the atomic UTC slot fact limits the total work units per kind; a consumed
slot covers both parts, including retries and outcome writes. Paid can allocate
several pages per tick, but the per-invocation budgets still bound every
fan-out.

### Status and capacity

Status reports the current rotation and whether processing is complete, the last
processed page, pending probe, missing-object and target counts, the oldest
pending observation and due time, and the latest error. A pending row without a
recent attempt may indicate a future retry time, unavailable queue capacity or
failed delivery; status displays the facts without selecting one cause.

With twelve 500-row page allocations per five-minute tick, one million rows
require at least 167 ticks, about 13.9 hours at that cadence or 166.7 hours at
an hourly cadence. One page per hour takes at least 2,000 hours, about 83.3
days. These are ideal allocation calculations. Missing-object reference queries
and tenant RPCs add work that depends on fan-out and fleet size. At twelve pages
for each of two kinds every five minutes, the nominal demote traffic is 6,912
messages and about 20,736 Queue operations a day, before retries and other queue
traffic. A 30-day month contributes about 622,080 operations; a 31-day month
contributes 642,816. These figures are not a whole-deployment Queues allowance
guarantee. [Queues pricing] describes the current included allowance.

Tests cover concurrent duplicate pages, an empty first page, stale rotation
identity, a crash after HEAD but before cursor advancement, a crash between HEAD
and work-row insertion, a persistent HEAD failure alongside later healthy pages,
a high-fan-out NAR whose first targets remain referenced after success, a CAS
digest with more references than one receiver invocation can process, a new
reference that appears during checking, one permanently failing tenant alongside
other pending objects, and target cleanup after an incarnation change.

## 4. The cache catalogue migration

Today the tick selects tenants with a null catalogue version, then a message
calls `initialise()`. The object can continue bounded pages on its alarm, and
the separate local-step wake is selected by step. PR #413 changed catalogue
progress recording: `cache_catalogue_version` becomes current after catalogue
reconciliation but before local-schema contraction. A current marker therefore
proves catalogue conversion, not that `initialise()` has completed. Request
admission still enters object initialisation and returns a retryable response
while contraction remains pending.

The object's initialisation and alarm are the continuing worker. A shared
`initialiseOrArm()` path arms the alarm on both local-schema and catalogue
pending errors for `reportLocalStep`, offboard start, and maintenance RPC entry
points. The alarm's migration branch continues in bounded pages. A direct RPC
that reports pending work never treats the current D1 marker alone as ready. The
old `cache-catalogue-migration` message remains decodable through the rollback
window and acknowledges after making or scheduling a bounded attempt.

The local-step wake is the control-plane recovery path for active and suspended
tenants. Its producer selection includes tenants below the required local step
**or** with a null or mismatched catalogue version. The consumer's
`wakeLocalStepTenants()` revalidation uses that same disjunction; its present
`belowLocalStep(required)` filter alone would discard the exceptional tenant.
`recordWakeFailure()` uses the same condition, so a rejected RPC remains visible
even when the local step is already sufficient. `reportLocalStep()` already
initialises before returning `recorded` for a sufficient step; retain that
ordering and arm pending migration work. An offboarding tenant uses the offboard
start and its tick backstop instead of the local-step selection.

Ordinary predecessor state may make the extra predicate empty, because the
marker is written before a sufficiently high step is recorded. The repair path
still needs a seeded test with an already-sufficient step and a missing or
mismatched version, both before and after object initialisation. A second test
pauses contraction after the marker becomes current and checks the retryable
HTTP response, alarm continuation and eventual ready step. Tests also cover a
pending catalogue migration on offboard start, an old queue message, duplicate
wakes and rollback to a predecessor build while the alarm key and queue message
remain persisted.

Status reports the count and a bounded sample of non-tombstoned tenants whose
catalogue version differs from the current version, alongside local-step
readiness and migration errors. A zero version-mismatch count shows catalogue
conversion at that D1 read; it does not prove local-schema contraction or
request readiness. Neither fact is inferred from a successful wake message.

## 5. The shared-object reapers

The current consumer chains `delete-existing`, `recover`, `arm`, `collect` and
`delete-collected` through self-sent queue messages. One early phase can keep
the chain busy, and an unbounded stray-marker delete in `drainObjectDeletions()`
can write far more rows than its page limit suggests. The incarnation and
reference fences already make repeated and overlapping phase calls safe; the
control plane remains the correct place for shared object work.

The simpler replacement schedules one bounded message **per phase and object
kind** at each due tick. The tick sends ten independent messages. No phase sends
another message. Each phase has its own `reconciliation_run` row and Free UTC
admission slot, so a failed early phase neither spends another phase's statement
allowance nor prevents its invocation. The phases may run in a different order
or overlap; correctness depends on the existing atomic fences and durable
deletion markers, not on one invocation's phase order. Tests must prove this for
both NAR and CAS before the chain is removed. If a specific phase dependency
fails that test, schedule that pair in one message with a reserved budget for
each, rather than restoring a continuation chain.

Each invocation has one cooperative wall-clock deadline shorter than the
platform limit, a binding-level statement allowance and a reserved statement and
time margin for its outcome fact. It runs bounded pages until the phase reports
no eligible work, the budget is nearly spent or a page changes nothing. The
stray-marker step first selects at most one page of due marker keys and then
deletes those exact keys; its current unrestricted `DELETE` becomes a bounded
operation. A non-empty deletion page currently calls D1 to delete stray markers,
D1 to select markers, R2 to delete bytes, and D1 to remove marker rows: four
tracked binding calls. The first delete can affect unbounded rows today and is
not acceptable as a bounded page. `recover` accounts for its reservation reads
and writes separately. `arm` and `collect` select eligible rows through indexed,
bounded queries; if a fenced batch changes nothing because references changed,
advance a persisted keyset position so later eligible rows receive an
opportunity. A completed pass can reset the position for the next interval.
Validate those queries' rows-read cost and the exact D1 statement count on
representative backlogs.

A phase's `completed_at` means that invocation observed no eligible work for
that phase at its final query. It does not mean the five-phase pipeline was
globally empty or that no new reference or deadline appeared afterwards.
`left_work_at` means a page or budget left eligible work. A thrown phase records
its own error; other phase messages still run. A successful phase does not clear
another phase's error. Status groups the five phase facts per object kind and
shows which phases last observed work, exhausted a budget or failed. An old
start timestamp is an observation only; it cannot prove why a message did not
start.

The cost of a run cannot be derived from a count of binding calls. D1 batches
contain multiple statements, and rows read and written depend on indexes and
population. Measure phase pages on sparse and full NAR and CAS fixtures,
including a page with many referenced candidates and stray markers. Use those
figures in the Free aggregate worksheet before activating the new cadence. At
five-minute Paid cadence, ten ordinary phase messages per tick contribute 2,880
messages and about 8,640 Queues operations a day before retries. Include this
traffic with demote and other messages in the rollout's queue latency and
monthly cost observations.

## 6. The membership refresh

Today `refreshTenantMembership()` runs inline before the tick sends any other
maintenance message. It writes one marker for every live tenant and then the
filter. That exceeds Free's 1,000 KV writes a day at a modest tenant count and a
KV failure prevents the tick from sending unrelated work. A valid but stale
filter can reject a newly created tenant. If the filter is missing or cannot be
read, `admitTenant()` falls through to the marker and then D1; a missing filter
alone does not reject admission. The filter construction itself is deterministic
for a given set because its initial seeds are fixed. Those facts matter to the
recovery contract.

The tick sends an independent `membership-refresh` message. On Free, one UTC
slot per hour admits the refresh before any KV write; duplicate deliveries
cannot double its scheduled KV expenditure. The consumer reads live D1 slugs in
keyset pages of at most 500 and builds one filter from at most 10,000 slugs. At
this cap, the page reads use at most 21 statements, including the sentinel page,
before publication and outcome writes. The same bound applies to the creation
path's rebuild. A fleet above that limit deletes the KV filter and reports
`filter capacity exceeded`; marker-first admission remains available until a
later design increases the cap or replaces the filter. A stale edge copy expires
after its ten-second TTL. A successful build publishes the filter and purges its
local edge-cache copy. Unconditional publication repairs a prior overwrite
without a D1 digest that can disagree with KV. The Free worksheet includes all
returned and scanned D1 rows, the sentinel read, filter writes, outcome facts
and index maintenance. A construction or D1 failure leaves the previous filter
in place and records an error; valid-filter misses still check the marker, so a
newly created tenant remains reachable when its marker is visible.

Marker repair is a separate bounded page, not a second full D1 snapshot. List at
most 100 KV marker keys from a persisted list cursor. For listed keys, read the
corresponding D1 statuses in bounded JSON batches. Delete a marker only when its
slug has an `offboarded` tombstone; a missing row is not evidence for deletion
because creation may be concurrent. To find missing live markers, advance a
separate keyset cursor through at most 100 live D1 slugs and check their KV
keys. The Free release caps repairs at 20 marker puts and 20 tombstone deletes
per admitted hour. The two cursors advance after their page's outcomes are
recorded and restart when exhausted; failures repeat the page. These limits
cover normal and duplicate delivery without an unbounded list or a write for
every tenant. The consumer records partial repair and errors separately from
filter publication. A failed KV operation does not stop the other kinds that the
tick scheduled.

The existing creation path still writes the marker and publishes a filter.
Overlapping creation and refresh publishers can put an older filter last. KV
provides no compare-and-set and propagation can take sixty seconds or more.
Under successful subsequent delivery, the next refresh is expected to repair
that filter. Queue delay, repeated failures and a late old publisher mean there
is no fixed one-hour recovery guarantee. Status reports publication attempt,
success, unfinished marker count where measured, and the latest KV error. It
does not claim that a recent write is globally visible.

Admission checks the per-tenant marker when a valid filter misses. A present
marker permits the authoritative D1 read; a missing marker rejects that slug. If
the marker read fails while the filter is valid and negative, admission rejects,
so an unknown-slug spray cannot turn a KV failure into D1 queries. If the filter
itself is unavailable, keep the existing marker-first fallback and D1 read on a
KV error. This improves recovery from a stale filter without reading D1 for
every unknown slug. A newly written marker can itself remain invisible in
another location, so creation still has an eventual consistency window.
Unknown-slug traffic now consumes KV reads; Free's 100,000-read daily allowance
can be exhausted by sufficiently high traffic. That tradeoff is part of this
admission contract and must be visible in observability and the operator guide,
not exposed as a correctness-policy switch.

On Free, hourly admission permits at most 24 filter writes, 480 marker puts and
480 marker deletes a day from this job. Puts and deletes have separate KV
allowances; creation adds its own marker and filter writes. One marker list page
per hour contributes at most 24 list requests a day before errors or retries.
The slot is consumed before KV work, so a failed page retries in the next slot
and cannot double the same hour's allowance. The daily worksheet still includes
creation and other KV users, and the limits do not reserve Free capacity against
unbounded foreground creation. Repairing 5,000 missing markers takes at least
250 admitted hours at 20 puts per hour, before delays and failures. The current
full `membership rebuild` cannot safely do that repair on Free. Change that
procedure to request bounded repair and report remaining work. Paid may use a
larger fixed page after measuring KV and D1 costs. The cursor resets
periodically so eventual consistency and concurrent creation do not leave a slug
permanently unexamined.

Tests cover deterministic filter bytes, a stale valid filter, an unavailable
filter, creation between D1 snapshot and KV listing, a late older publisher,
partial marker repair across several runs, capped tombstone deletion and its
retry after failed finalisation, concurrent duplicate refreshes, and Free
recovery of a 5,000-marker loss without a full rebuild call.

## 7. Control-key retirement

Control-key retirement stays on the tick. The current helper selects every due
key and may issue a second D1 query after a no-op guarded update. A fixed 50-key
selection already exceeds Free's 50-query invocation allowance when all updates
succeed, before attempt and outcome facts.

Select a page whose size derives from the remaining binding-level statement
allowance, with room for the selection, the worst-case per-key path and the
outcome write. Retire each key through the existing conditional last-live-key
fence. On Free, admit at most one bounded retirement run per UTC tick slot;
concurrent duplicate messages cannot spend the same slot twice. Record the
attempt, any changed key, an unfinished due page, a fully empty due page and
errors with conditional timestamps. A subsequent tick resumes due keys. The
status shows keys currently due, last observed attempt and last error; it does
not infer a message failure from an old attempt alone. Tests cover a
full-success page, the no-op second-query path, duplicate delivery, a last live
key, and capacity reserved for outcome recording.

## What is recorded where

| Kind                   | Control D1 facts                                                                                                                                    | Tenant object state                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Offboarding            | Registry status; per-part attempts, progress, completion and errors; drained, finalisation and marker-cleanup facts; shared Free row admission slot | Durable fence, pending marker, separate part completion and retry deadlines |
| Tenant maintenance     | Eligibility deadline, projection-missing marker, heartbeat and per-pass outcomes                                                                    | Pass cursor, retry deadlines and periodic check time                        |
| Demote scans           | Rotation allocation, pending objects and exact target receipts                                                                                      | Existing tenant-side narinfo and attestation state                          |
| Reapers                | One run row per phase and object kind, including Free admission                                                                                     | None                                                                        |
| Catalogue migration    | Tenant catalogue version and local-step facts                                                                                                       | Migration journal and alarm                                                 |
| Membership refresh     | Run row, repair position and observed errors                                                                                                        | None                                                                        |
| Control-key retirement | Run row and the existing key state                                                                                                                  | None                                                                        |

No derived progress counter is required. The operation that mutates an object or
row remains responsible for its own idempotence and fence.

## Behaviour at 5, 200 and 5,000 tenants

These figures are arithmetic under ordinary single delivery. They are not
throughput or recovery guarantees.

| Kind                 | 5 tenants                                                            | 200 tenants                                       | 5,000 tenants                                                                                                       |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Offboarding          | One object per tenant; terminal work needs a D1 and R2 residue check | Concurrent Paid drains contend on one D1 database | The Free row schedule admits one page globally per configured slot; capacity depends on measured page cost          |
| Periodic maintenance | Free selects up to `P` per hour; Paid averages 0.83 alarms/hour      | Free still selects up to `P`; Paid averages 33.3  | Free needs at least `ceil(5,000 / P)` hourly selections; Paid averages 833.3 alarms/hour                            |
| Backstop             | One selection can include the fleet                                  | A bounded selection can include the fleet         | At least 50 selections with the existing 100-tenant cap to visit every eligible tenant                              |
| Demote audit         | One page can scan a small shared table                               | Work depends on shared-object count               | A million shared rows need at least `ceil(1,000,000 / cap)` processed pages; the Free target cap of 500 needs 2,000 |
| Membership listing   | One bounded KV list page per refresh                                 | Same one-page bound                               | A 5,000-marker rotation needs at least 50 admitted 100-key pages; later runs revisit the namespace                  |
| Catalogue recovery   | Bounded migration pages after a wake                                 | Same per object                                   | Local-step fan-out can produce 250 messages for 5,000 selected tenants                                              |

The Paid five-minute demote traffic plus ten reaper phase messages per tick
contributes about 29,376 Queues operations a day before retries, verification
and other messages. That is about 881,280 operations in 30 days or 910,656 in 31
days. The included Paid allowance is one million operations a month, then $0.40
per extra million [Queues pricing]. If total usage doubled this nominal
baseline, the extra 30-day charge would be about $0.31. That allowance is a
billing threshold, not a hard capacity limit, so it does not justify delaying
repair. Measure whole-deployment traffic and queue latency during rollout to
detect a real throughput or cost problem. On Free, the 10,000-operation daily
allowance includes retries and tenant work and remains an admission constraint.

## Evidence and measurement gates

The existing Workers tests can establish SQL shape and local cost before a
production change.
`packages/server/src/do/maintenance-eligibility-cost.workers.test.ts` already
compares small and larger backlogs through the local row meter and uses
`EXPLAIN QUERY PLAN`. `packages/server/src/routing/scheduled.workers.test.ts`
seeds control-plane tenants and exercises queue decisions. These tests establish
only their present queries: for example, the maintenance eligibility test
expects its reconciliation read to stay at ten rows with three and 197 queued
items. They do not measure any of the SQL proposed here, which has not been
written.

Add focused Workers fixtures for the new statements with 5, 200 and 5,000
tenants, sparse and full backlogs, and a high-fan-out shared object. For each
selection and mutation, capture the generated SQL, `EXPLAIN QUERY PLAN`, D1
`meta.rows_read`, `meta.rows_written`, statement count and elapsed time. Compare
empty and late-key pages with full pages. Include index maintenance, failed
conditional writes, duplicates and a partial page that stops after a committed
mutation. A page limit caps returned rows but does not cap rows scanned, so any
unindexed scan whose cost grows with the whole fleet fails the Free gate. Use
the project test command, for example:

```sh
pnpm --filter @cupboard/server exec vitest run src/do/maintenance-eligibility-cost.workers.test.ts
pnpm --filter @cupboard/server exec vitest run src/routing/scheduled.workers.test.ts
pnpm check:migrations
pnpm check
```

The first two commands exercise existing fixtures; implementation adds focused
cases beside them. The latter two are release checks, not evidence that the new
design has already passed. Local Miniflare D1 metadata and query plans show
whether a query is structurally bounded and can catch index regressions. They
cannot establish the hosted database's billing totals, Free quota usage,
production D1 queueing, cross-colo KV propagation or whole-deployment Queues
traffic. Before activating a Free kind, compare its local fixture results with
D1 metadata from a controlled non-production deployment on the intended plan,
then fill the daily worksheet. No production data mutation is required for this
design review. Paid cadence tuning uses hosted queue latency, D1 overload errors
and monthly operations after activation; those observations do not block
building the bounded implementation.

The Free acceptance worksheet has separate read and write columns. For every
kind it multiplies the maximum admitted UTC slots by a justified per-unit
ceiling, then adds empty tick selections, outcome and index writes, retry paths,
terminal residue checks, periodic selection and tenant facts, membership repair
and a unit that straddles midnight UTC. Include the configured maximum queue
retry count and one prior-hour Free periodic group of `P` pages. The elective
total must stay below 2.5 million rows read and 50,000 rows written per day. A
future table population can exceed a measured sample; the corresponding query
must have an indexed bounded access path or the new Free profile remains
disabled until it is corrected. The same review keeps each Free dispatch under
50 D1 statements, each Paid dispatch under 1,000, and all subrequest, parameter
and time limits. The wrapper enforces invocation statements; the UTC admission
facts bound scheduled units; neither can reserve D1's daily allowance against
arbitrary foreground traffic.

## Migration and release sequence

`schemaTransitions` fixes a transition's migration list once released. Put the
initial additive D1 tables and indexes in one new `reconciliation-facts`
transition, starting with the next available number after `0033`:
`reconciliation_run`, `object_demotion`, `object_demotion_target`, tenant
outcome, periodic selection and terminal-cleanup facts, and selection indexes.
No released transition gains a migration. The transition has no contract step
because the initial schema only adds compatible state. Local Durable Object keys
are added by compatible code, not by editing an earlier object migration. A
later schema change gets a later transition. Run `pnpm check:migrations` and
predecessor upgrade fixtures before every release that changes D1 or local
storage.

Each numbered phase can be reviewed and deployed separately. Its producer stays
disabled until its consumer, schema and rollback decoder are present. Keep the
previous scheduling path and its data columns through a tested rollback window.
A rollback build may safely leave new facts and alarm keys untouched, but must
not consume a new queue message and discard work that only the new build can
complete. The initial compatibility release must understand every new message
kind before any later release produces one.

1. **Compatibility and budget foundation.** Add the additive transition, typed
   conditional outcome writes, statement wrapper, plan-derived variable in both
   Worker scripts, Free UTC admission and decoders with dormant new consumers.
   Bound or disable the predecessor's unpaced Free offboard rows and reaper
   chain before treating it as a rollback target. Keep the current hourly
   producers active otherwise. Gate this phase on simultaneous slot claims,
   refused atomic batches, nested and interleaved dispatch budgets, unknown
   binding methods, missing/invalid plan variables, two-script deploy
   propagation and a predecessor rollback with new rows present.
2. **Catalogue recovery.** Unify pending-migration alarm arming and add the
   catalogue-version predicate to producer selection, consumer revalidation and
   failure recording. Keep the old message decoder. Gate activation on an
   already-current local step with null and mismatched versions, plus the
   interval after catalogue completion but before schema contraction. Confirm
   that requests still receive a retryable response then. This phase needs no
   new D1 migration and can roll back while the old hourly catalogue producer
   remains available.
3. **Membership and control keys.** Move membership work out of inline tick
   execution, add bounded filter construction and marker cursors, and make
   valid-filter misses consult the marker. Bound key retirement under the same
   statement and Free slot policy. Gate activation on 5,000-key marker loss,
   creation/filter races, tombstone-only deletes, an invalid filter, a KV
   failure, duplicate queue delivery and the full-success/no-op key paths.
   Preserve the old message decoder; rollback restores the old producer only
   while its Free work is bounded. Ship typed status for these kinds with this
   phase.
4. **Demote audit and repair.** Add processed-before-advance rotations,
   pending-object and exact-target rows, bounded NAR and CAS tenant RPCs, and
   the fenced final delete. Gate activation on duplicate pages, crashes before
   cursor advancement, one persistent HEAD failure alongside healthy later
   pages, high fan-out, a concurrent new reference, a changed incarnation, one
   permanently failing tenant and the Free receiver's query allowance. The old
   scanner remains disabled only after the new cursor has begun a rotation;
   rollback retains pending facts for the new build and uses its compatible old
   scanner as a bounded audit backstop.
5. **Shared reapers.** Replace each self-sent phase chain with one bounded
   message per phase and object kind. First bound the stray-marker delete and
   prove every phase is safe under duplicate, concurrent and out-of-order
   delivery. An early phase failure must leave other phases runnable. Keep old
   phase messages decodable until the queue and rollback window clear. Activate
   the Free schedule only after every phase passes the row worksheet.
6. **Tenant maintenance.** Add the `deferred` alarm result, pass-specific
   outcomes, heartbeat and missing-projection facts. Arm deadline work on both
   plans and periodic work on Paid. On Free, admit the bounded due selection,
   send twenty-tenant groups, and let only assigned objects run one page. Keep
   the broad hourly backstop until a bounded D1 query shows every active tenant
   has a new-build heartbeat, or retain it when its measured cost fits. Gate
   narrowing on plan-specific predicates, fair due ordering, a 100-tenant JSON
   assignment batch, duplicate and expired messages, an idle upgraded object, a
   reset object, a missed send and an assignment that crosses midnight. A recent
   heartbeat must not hide a missing projection or an overdue epoch deadline.
   Check the Paid six-hour pass and report the Free oldest-due age.
7. **Offboarding.** Add the durable fence, shared lifecycle gate and
   statement-level active-status predicates before enabling alarm drains. Then
   add independent row and object pages, bounded quiescence, tombstone before
   local purge, and recurring tombstone residue repair. Gate activation on a
   paused D1 batch, an abandoned tenant-prefix R2 put, a forced reset, timed-out
   writer quiescence, duplicate finalisation, marker failure and bounded cleanup
   after the object has been purged. Keep old producer compatibility until every
   offboarding tenant has a new-build attempt.
8. **Status and retirement.** Complete the contract-first status and CLI view as
   kinds activate. Verify the grant, bounded pages, safe error summaries and
   overlapping pass outcomes. Update the operator guide and PLAN.md with
   measured capacity. Stop old producers only after new facts show coverage;
   remove old cursors, `consecutive_failures` and obsolete decoders in later
   contract transitions after the rollback window. A timer alone does not
   establish fleet coverage.

Before enabling a phase, record the exact deployed control and tenant script
versions, migration state, plan variable, producer state and local/hosted cost
results. After enabling, inspect its status for progress, errors and pending age
over at least one full scheduling interval, including a quiet interval that
should complete. A zero sample from one page is not a global completion claim.
Keep old consumers decodable during rollback. If a phase repeatedly exceeds its
statement or row ceiling, overloads D1, or produces unbounded queue retries,
stop its new producer and restore the compatible schedule; leave durable pending
facts for the corrected build. Never delete a pending row merely to make status
look clear.

Rollback tests start with persisted predecessor data, activate the new build,
leave alarms, queue messages, pending demotion targets and new D1 facts, run the
compatible rollback build, then upgrade again. Cover a Free offboard row page
waiting for a slot, a tombstoned tenant with late prefix residue, a catalogue
migration alarm, every new queue variant, a missing projection marker and a
pending reaper phase. The rollback build must keep ordinary requests safe,
refuse writes to retired tenants and leave work intact when it cannot continue
it. Verify the final data and status, not only successful deployment commands.
