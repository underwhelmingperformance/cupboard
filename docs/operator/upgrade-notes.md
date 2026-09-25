# Upgrade notes

Most releases upgrade with a plain `cupboard deploy`, as described in
[Upgrading](./upgrading.md). This page lists the releases that need something
more from you, newest first. If a release isn't listed here, the normal
procedure is enough.

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

### How each tenant migrates

Each tenant goes through five steps. A tenant does a limited amount of work each
time it's woken, so a large tenant may need several wakes for each step.
`cupboard deployment status` shows the progress.

1. The tenant records the lifecycle of each of its caches in D1, 36 caches per
   wake.
2. It moves the stored objects of private caches away from their old `private/`
   keys.
3. It moves the stored objects of caches that were deleted and then created
   again with the same name, to new storage locations.

   Steps 2 and 3 move up to 100 objects per wake. Requests for an object that
   hasn't moved yet return 404. Pushing the path again also makes it available.

4. It imports the old tenant-wide retention and grace policies into each cache's
   settings, 50 per wake. Until this finishes, cupboard refuses to create a
   cache with a root TTL or grace period, or to change either setting.
   `cupboard policy list` shows the policies that haven't been imported yet. A
   policy can have more rules than the new settings support. If so, remove it
   with `cupboard policy remove` or `cupboard policy remove-grace`.
5. It rewrites its stored trust rules and refresh tokens in the new grant
   format, 100 of each per wake.

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
upgrade removes the credentials of caches that were deleted before it.

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
