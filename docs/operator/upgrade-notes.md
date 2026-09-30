# Upgrade notes

Most releases upgrade with a plain `cupboard init`, as described in
[Upgrading](./upgrading.md). This page lists the releases that need something
more from you, newest first. If a release isn't listed here, the normal
procedure is enough.

## Next release

These notes apply to the first release after v0.0.35.

### CI read acquisition

Upgrade the deployed Worker before using this release's
`cupboard run --github-oidc`. Read acquisition uses a new extension grant at the
tenant token endpoint; an older Worker returns `unsupported_grant_type`. Setup
also needs this release's CLI for OIDC-backed configuration. Public read-only
jobs continue to run anonymously without a matching CI trust rule or
`id-token: write`.

### Updating a deployment needs an admin token

- `cupboard init` now needs an admin token to update a deployment that has an
  admin. A CI job that updates a deployment with `CLOUDFLARE_API_TOKEN` alone
  stops before it changes anything. Give the job `--github-oidc`, the
  `id-token: write` permission, and a control trust rule that gives the workflow
  the wildcard grant. See [Updating from CI](./upgrading.md#updating-from-ci).
  In a terminal, `init` signs you in as the admin when it needs to.
- Moving a deployment to a new URL, including adding a first custom domain,
  needs an admin token for the new URL. After a move, runs with `--github-oidc`
  request the new URL as their audience, so pass `--audience` with the old URL
  or add a control trust rule for the new URL. See
  [Moving to a new URL](./deploying.md#moving-to-a-new-url).
- `init` refuses a plan that selects a D1 database other than the deployed
  Workers' database if either database records an admin. See
  [Changing the control database](./deploying.md#changing-the-control-database).
- If the control Worker of a claimed deployment was deleted, `init` can't update
  the deployment until you redeploy the control Worker with Wrangler. See
  [If the control Worker was deleted](./deploying.md#if-the-control-worker-was-deleted).

### Claiming a new deployment

- `init` generates the claim secret itself, sets it on the control Worker for
  the claim, and removes it afterwards. `CUPBOARD_SIGNUP_SECRET` in the
  environment is no longer passed to the Worker, so a workflow that claimed a
  deployment by exporting it now leaves the deployment without an admin.
- The plan menu no longer has an entry for the admin. The identity that you sign
  in with for the claim becomes the admin. See
  [Claiming the deployment](./deploying.md#claiming-the-deployment).
- A first deploy without a terminal can't claim the deployment, and exits with a
  non-zero status.
- `/signup` ignores `CUPBOARD_SIGNUP_ISSUER`, `CUPBOARD_SIGNUP_AUDIENCE` and
  `CUPBOARD_SIGNUP_SUBJECT`. A deployment that relied on a pinned subject, or on
  `CUPBOARD_LOCAL_DEV` to be claimed without a secret, can't be claimed until
  `CUPBOARD_SIGNUP_SECRET` is set on the Worker. `cupboard init` does that for
  you. Older CLIs can't read the new `/signup` response, so claim with this
  release's CLI.

### Schema transitions

- The deploy records its progress in the new `deployment_transition` table, and
  keeps the `deployment_phase` row up to date for v0.0.34 and v0.0.35. See
  [What a deploy does](./upgrading.md#what-a-deploy-does).
- The `deployment.transitions` control procedure replaces `deployment.phase`.
  Use `cupboard deployment status` and `cupboard deployment resume` from the
  same release as the deployed control Worker. The `--output-mode json` output
  of both commands changes: the `deployment-status` result has `transitions`,
  `unrecognised` and `required` in place of `phase`, and both results contain
  the new status fields below.
- Tenants now finish their migration work on their own after one wake. The
  deploy and `cupboard deployment resume` wake them once and wait while any of
  them is making progress, and the hourly cron job wakes the stalled ones again.
  `deployment resume` no longer has `--limit` and `--max-passes`. See
  [When a deploy stops before finishing](./upgrading.md#when-a-deploy-stops-before-finishing).
- `localStep.status` takes no query, and reports the pending tenants as
  `working`, `stalled` and `unwoken`, with `stalledSample` and `unwokenSample`
  in place of `stragglers`. `localStep.wake` takes no body, and reports
  `required`, `enqueued` and `pending` in place of the outcome for each tenant.
  The CLI and the server check these responses strictly, so a CLI from another
  release rejects them or gets 404.
- The new `local-step-attempts` transition adds migration `0033`, which records
  each tenant's last attempt at its migration work. It's independent, so it
  doesn't block an upgrade.

The independent `publication-identity` transition adds migration `0034`. It
records which upload committed each NAR reference so the server can distinguish
a completed upload from a competing or repeated commit. Existing reservations
are not copied because they do not establish which upload completed publication.

### Exit statuses and output

These changes affect scripts that check the CLI's exit status or parse its text
output. [Scripting the CLI](../reference/cli-scripting.md) lists the exit
statuses.

- `cupboard check` exits 1 when it finds discrepancies. It used to exit 0.
- An admin command exits 75 after a 408, 429 or 503 from the admin API, or after
  a 5xx other than 503 or 507 whose body is over 64 KiB. It used to exit 1. When
  an error body can't be decoded, the command exits 77 after a 401 or 403, and
  75 after a 408, 429 or 503.
- `cupboard push` exits 77, 75 or 69 when the failure of a path has one of these
  statuses, in that order of priority. It used to exit 1. A retry on 75 now
  publishes the paths that failed.
- `cupboard push --root` exits 2 when the push has more target paths than one
  push can retain. It used to exit 1.
- An interrupt while the CLI reads the body of a 4xx, 503 or 507 response from
  the admin API exits 130 for SIGINT or 143 for SIGTERM. It used to exit 1.
- `cupboard build-push` publication exits 77 or 75, in the same cases as the
  admin commands and `cupboard push`, where it used to exit 74. A commit that
  the storage quota refuses makes streamed `build-push` exit 74 instead of 75,
  so a script that retries on 75 no longer retries it.
- The text output of `oidc-trust list` and `control-oidc-trust list` shows a
  rule with a pinned subject as `<grants> <issuer> · <subject> aud=<audience>`.
  Read `--output-mode json` if a script parses the list.

### Adding trust rules from a file

- `cupboard control-oidc-trust add` takes the whole rule from `--from-file`,
  which it now requires. It no longer accepts `--issuer`, `--audience` or any
  other rule option. The command already took the rule from the file, so remove
  the other options from existing invocations.
- `cupboard oidc-trust add --from-file` refuses `--issuer`, `--audience` and the
  other rule options, which it used to ignore. Remove them from invocations that
  use `--from-file`.

## v0.0.34

This release changes how cupboard identifies caches, and how stored grants and
read credentials refer to them. Upgrading to it runs a migration in stages. Each
tenant converts its own data, and then the deploy removes the old formats.

### Before you upgrade

- Upgrade the CLI at the same time as the server. The `check` API now identifies
  caches by number. An older CLI can't read its responses. It also can't resume
  a check that it started before the upgrade, so start the check again with the
  new CLI.
- Until the upgrade finishes, cupboard refuses to change a cache's access, and
  refuses some retention changes. Older Workers could misread these changes
  while both versions are running.
- You can't roll back. Once you upload the new tenant Worker, each tenant
  converts its storage to a format that older Workers can't read. If the upgrade
  is interrupted, finish it by deploying this release again.
- Retention policies can no longer be added, so stored trust rules lose the
  `policy:add` operation. A session whose refresh token was granted `policy:add`
  stops renewing, so sign in again with `cupboard login`. `policy:list` and
  `policy:remove` still work, for removing old policies.

### How each tenant migrates

Each tenant goes through five steps. A tenant does its work in pages, a limited
amount at a time, and a large tenant needs several pages for each step. With the
release after v0.0.35, a woken tenant runs its pages on its own until it has
finished; v0.0.34 and v0.0.35 run one page each time the tenant is woken.
`cupboard deployment status` shows the progress.

1. The tenant records the lifecycle of each of its caches in D1, 36 caches per
   page.
2. It moves the stored objects of private caches away from their old `private/`
   keys.
3. It moves the stored objects of caches that were deleted and then created
   again with the same name, to new storage locations.

   Steps 2 and 3 move up to 100 objects per page. Requests for an object that
   hasn't moved yet return 404. Pushing the path again also makes it available.

4. It imports the old tenant-wide retention and grace policies into each cache's
   settings, 50 per page. Until this finishes, cupboard refuses to create a
   cache with a root TTL or grace period, or to change either setting.
   `cupboard policy list` shows the policies that haven't been imported yet. A
   policy can have more rules than the new settings support. If so, remove it
   with `cupboard policy remove` or `cupboard policy remove-grace`.
5. It rewrites its stored trust rules and refresh tokens in the new grant
   format, 100 of each per page.

Steps 1 to 4 happen before the deploy removes the old D1 format, and step 5
happens after. One deploy runs both stages. If the deploy is interrupted,
`cupboard deployment resume` continues the current stage, and running
`cupboard deploy` again finishes the rest.

Later deploys don't move the objects from steps 2 and 3 back. An older Workers
build can't find them at their new keys.

### Adding trust rules during the upgrade

Until the upgrade finishes, cupboard stores new trust rules in the old grant
format, so that the old Workers can still read them. Some cache name templates
are too long for the old format. A rule with one of those is refused with
`CACHE_GRANT_MIGRATION_PENDING` (HTTP 409). Add the rule after the upgrade has
finished.

### Checking cache read credentials

From this release, removing a cache also removes its read credential. The
upgrade removes the credentials of caches that were deleted before it. The D1
migration `0030_cache_credential_lifecycle` does this. Its comment refers to
"Cache read credentials" in `docs/deploying.md`, a page that has since been
split up. This section replaces it.

It can't do that for a cache name that was deleted and then used again, because
it can't tell whether a credential belonged to the old cache or the new one. It
leaves those credentials in place. After upgrading, find them with this D1
query:

```sql
SELECT c.tenant, c.cache_name, c.access, c.generation, r.created_at
FROM cache_lifecycle AS c
JOIN tenant_cache_read_credential AS r
    ON r.tenant = c.tenant
    AND r.cache_kind = c.cache_kind
    AND r.cache_name IS c.cache_name
WHERE c.cache_kind = 'named'
    AND c.deleted_at IS NULL
    AND c.generation > 1
ORDER BY c.tenant, c.cache_name;
```

A `generation` above 1 means that the cache name has been deleted and used again
at least once. `created_at` shows when the credential was set, but not which
cache it was set for. Ask the tenant's administrators whether the cache's
readers should keep using the credential. Then do one of these:

- Give the cache a new credential:

  ```sh
  cupboard tenant rotate-cache-credential <url> <tenant> <cache>
  ```

- Remove the credential:

  ```sh
  cupboard tenant clear-cache-credential <url> <tenant> <cache>
  ```

  The cache then accepts the tenant read credential instead, so anyone who has
  the tenant read credential can read it.

Use these commands. Don't edit D1 directly.

### Pull request caches and the flake publish workflow

- Pull request caches now belong to a repository. The `pull-request-and-branch`
  preset used to publish each pull request to a cache called `pr-<number>`. It
  now uses `gh-<repository-id>-pr-<number>`. Runs on `main` used to read from a
  shared view called `pull-requests`. They now read from a view for each
  repository, `pull-requests-<repository-id>`.

  To switch over, run `cupboard github setup` again for each repository. It asks
  before replacing the old pull request trust rule, or replaces it straight away
  with `--yes`. It also creates the repository's view. If any caller sets
  `reuse-view: pull-requests`, remove that input.

  The old view and the old caches stay in place. Remove them once nothing uses
  them. Existing roots keep their expiry times.

- Pull requests create and remove their own caches. The preset creates each pull
  request's cache with a default root TTL of 14 days. It removes the cache when
  the pull request is closed without being merged. For this to work, add
  `closed` to the `pull_request` event types in the calling workflow.
- The workflow takes two pairs of read credentials. The `read_user` and
  `read_password` secrets are replaced by `destination_read_*` and
  `fallback_read_*`. See [Private caches in CI](../ci/private-caches.md).
