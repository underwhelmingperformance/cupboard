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

The tenant Worker records exceptional failures to settle an upload in
`pending_upload.settle_failures` and `last_settle_error`. It delays each retry
by 30 seconds initially, doubling the delay up to ten minutes. The
`pending upload verification failed` log includes the upload ID, failure count,
phase and last error. The row remains eligible for recovery after the retry
deadline, including when a commit has already changed shared storage. Check the
last error and the storage service if a client repeatedly times out while
waiting for verification. A normal deferral does not increase the count.

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
