# Troubleshooting

This page lists common problems, grouped by where you see them. Where cupboard
prints an error, the heading quotes the message so that you can search for it.

## Nix clients

### Nix doesn't download a path that was just pushed

When Nix asks a cache for a path and the cache doesn't have it, Nix remembers
the answer for an hour. This is controlled by `narinfo-cache-negative-ttl`. If a
client asked for the path before you pushed it, the client keeps building the
path instead of downloading it until that hour has passed.

To make one command ask the cache again, add
`--option narinfo-cache-negative-ttl 0`.

Also check that the path is in the cache that the client reads from. The default
cache and each named cache are separate substituters, so a path pushed to one
isn't visible through another.

### "lacks a signature by a trusted key"

The client doesn't trust the key that signed the path's narinfo. Compare the
cache's current keys with the client's `trusted-public-keys` setting:

```sh
curl -fsS https://cupboard.example.workers.dev/t/acme/pubkey
```

If the tenant has rotated its signing key, add the new key to the client. See
[Rotating the signing key](./admin/keys.md#rotating-the-signing-key).

If the user running Nix isn't in the daemon's `trusted-users`, the Nix daemon
ignores their own `trusted-public-keys` and substituters. Add the key and the
cache to the daemon's configuration instead.

### A private cache returns 401

There are two usual causes:

- The credential isn't the right one for this cache. If the operator has given a
  cache its own credential, that cache accepts only that credential. The tenant
  read credential doesn't work for it.
- Nix isn't reading the netrc file that contains the tenant read credential.
  Check the `netrc-file` setting in `nix config show`, and check that the Nix
  daemon can read the file.

### A private cache stops being used, without an error

If Nix can't read an included configuration file, it skips the file without an
error. If a file included with `!include` is missing, Nix also skips it without
an error, and the NixOS module uses `!include`. If the cache's substituter line
is in an included file, check the file's path, owner and permissions. See
[If something goes wrong](./use/private-caches.md#if-something-goes-wrong).

## CLI

### "No cupboard session, or it has expired. Run `cupboard login`."

One of these is true:

- You haven't signed in to that URL.
- Your session has expired and the CLI couldn't renew it.
- No trust rule accepts you at that URL.

Sessions belong to a single URL. A session for a tenant URL doesn't work for
operator commands, which use the deployment URL, and an operator session doesn't
work for a tenant. If you aren't an operator, you'll see this message when you
run an operator command.

### "Your token lacks the scope this command needs."

You're signed in, but your session doesn't allow this command. Tenant commands
need a tenant administrator's session. Commands such as `tenant` and
`control-key` need an operator's session.

### "This is a destructive action; re-run with --yes to confirm."

The command needs you to confirm it, but it can't ask, because it isn't running
in a terminal. Add `--yes` to confirm in advance.

### `build-push` exits with status 77 before building

`build-push` needs to set Nix's `post-build-hook`, and only users that the Nix
daemon trusts can do that. Add your user to the daemon's `trusted-users`. See
[Publishing while a build runs](./admin/pushing.md#publishing-while-a-build-runs).

### "Invalid store path"

`push`, `root set` and `delete` take store paths. `push` also accepts a symlink
to a store path, such as `./result`. No command accepts a flake reference, so
build the flake output first and pass the result.

If you run `push <tenant URL> <name> …`, `push` first checks the filesystem. If
a file or directory called `<name>` exists, `push` treats `<name>` as a path.
Otherwise, `<name>` is a cache name if a cache with that name exists, and a path
if not. To push to a new named cache, use the cache's URL instead. Pushing to
the URL creates the cache.

## CI publication

Start by running `cupboard github check`. It tests your tenant's trust rules
against the claims that a real run would present, and tells you which check
fails. See [Check the setup](./ci/quickstart.md#5-check-the-setup).

### "No trust rule matches the subject token"

Either no trust rule accepts the job's token, or more than one rule does and
cupboard can't choose between them. Check that a rule:

- matches this repository's `repository_id` and `repository_owner_id`;
- matches the kind of run: `event_name` for pull requests, `ref` for a branch,
  or `ref_type` for tags;
- matches the workflow and ref that the caller uses in `job_workflow_ref`, for
  example `…@refs/tags/v*`. If the rule expects a tag, the caller mustn't refer
  to the workflow by commit SHA;
- has the tenant URL, without a trailing slash, as its audience.

If a rule matches the token's exact repository IDs, the error message identifies
that rule and the first claim that didn't match.

If two rules are equally specific and both allow the request, cupboard refuses
it. Remove one of the rules.

### "The requested authorization_details are not permitted"

A trust rule matched the token, but it doesn't allow everything that the job
asked for. For example, the job might need `root` for its root, `attach` for a
run root, or `attest`. cupboard never combines rules, so a single rule must
allow everything. See
[When several rules match](./ci/trust-rules.md#when-several-rules-match).

### The preset fails the run

The `pull-request-and-branch` preset fails pull requests from forks. It also
fails runs on any branch other than the one set in `branch`. Skip fork pull
requests with the `if:` condition shown in
[Add the workflow](./ci/quickstart.md#4-add-the-workflow), and limit the
workflow's triggers to pull requests and that branch.

### A tag publish can't find its cache

A trust rule made with `add-github-tag` can't create caches. Create the cache
before the first tag run. See
[Publishing releases](./ci/flake-publish.md#publishing-releases).

### Setup refuses the reuse view's priority

Nix must try the reuse view after the cache that the run publishes to, so the
view's priority number must be higher than the cache's. If someone has raised
the cache's priority number, raise the view's too.

`cupboard reuse-view set` replaces the whole view, so pass the view's selectors
and access again along with the new priority. `cupboard reuse-view list` shows
them. For the view that `cupboard github setup` creates, that looks like this:

```sh
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme \
  pull-requests-123456789 --select prefix:gh-123456789-pr- --priority 60
```

Add `--access private` if the view is private.

### A private cache refuses the credential

If a cache has its own credential, it accepts only that credential. Pass that
credential in the `destination_read_*` secrets. A private reuse view accepts
only the tenant read credential, which goes in the `fallback_read_*` secrets.
See [Private caches in CI](./ci/private-caches.md).

### A cohort refuses to build

The cohort's log gives the reason. For example, the runner might not have enough
free disk space for the build, or too many paths might be unavailable from any
substituter. You can split the cohort into smaller ones, free disk space with
`maximise-space`, or [build on other machines](./ci/building-elsewhere.md).

### A `main` run rebuilt something that a pull request had already built

Each of these must be true. Check them in order:

1. The run is a branch run. Only branch runs look for paths in the reuse view.
2. The pull request's cache still exists, and its name matches the view's
   selector. `cupboard reuse-view list` shows the selector.
3. The pull request's run published the path.
4. `main` built the same derivation. If `main` has changed since the pull
   request, or an output depends on the commit (for example through `self.rev`),
   the derivations are different.
5. Only one pull request cache has the path. If two pull request caches have the
   same path with different contents, the view can't choose between them, so it
   reports that it doesn't have the path.

### The plan refuses a manifest

The plan job checks the target manifest before anything is built. These are the
usual problems:

- One root would keep too many paths. A root can keep at most 149 paths, and all
  of an aggregate target's components share one root. Split the aggregate into
  smaller ones.
- A target has no `rootDrvPath`. Every target needs one unless it's best-effort,
  and that includes each component of an aggregate. With a remote store,
  best-effort targets need one too.
- The targets in one cohort don't agree on `system`, `os`, `remote` or
  `bestEffort`. Every target in a cohort must have the same values.
- A cohort job says that a target no longer evaluates to its `rootDrvPath`.
  Either the flake changed between planning and building, or `attr` and
  `rootDrvPath` refer to different derivations.

## Retention

### Paths have disappeared from a cache

There are four usual causes:

- The root that kept them has expired. `cupboard root list` shows when each root
  expires.
- No root keeps them. If you pushed a path with `--no-retain`, or a root stopped
  keeping it, the path only lasts for the cache's grace period.
- The cache is grace-managed. When all of its roots and grace periods have run
  out, garbage collection empties the cache. `cupboard cache inspect` shows
  whether a cache is grace-managed.
- Someone deleted them. `cupboard delete` removes paths even if a root keeps
  them.

See [Retention](./admin/retention.md).

### "… would exceed the tenant's storage quota"

The tenant is using all of its storage quota, so the upload was refused. The
command exits with status 1. To make room, you can:

- delete paths that you no longer need, with `cupboard delete`;
- remove roots with `cupboard root remove`, and let garbage collection delete
  the paths that they kept;
- ask the operator to raise the quota, with
  [`cupboard tenant set-quota`](./operator/tenants.md#changing-a-quota).

`cupboard usage` shows how much storage the tenant is using and what its quota
is.

### "Tenant … already stores …, which is more than the requested quota"

An operator can't set a tenant's quota below the amount that the tenant already
stores. Choose a larger quota, or ask the tenant's administrators to free some
space first.

### "Tenant … is being removed, so its status and quota can no longer be changed"

Once an operator starts removing a tenant, the removal can't be undone.
`cupboard tenant list` shows how far the removal has got.

## Deploying

### "The account has no workers.dev subdomain"

The Workers were deployed, but they aren't reachable yet. Register a workers.dev
subdomain in the Cloudflare dashboard, under Workers & Pages, and run
`cupboard init` again. Alternatively, deploy with `--domain` to use your own
domain.

### "R2 rejected the credentials (HTTP …)"

The HTTP status says what went wrong:

- A 404 means that the bucket doesn't exist yet. Create it in the Cloudflare
  dashboard, or choose "Deploy anyway" and let the deploy create it.
- For a 401 or 403, check the access key ID and secret, and check that the token
  has Object Read & Write permission on the bucket.

### "Nobody was made admin"

The deployment doesn't have an operator yet, and you deployed with an API token
or with wrangler's stored token. Neither kind of token includes your identity,
so the deploy couldn't make you the operator. Unset `CLOUDFLARE_API_TOKEN`, then
run `cupboard init --no-wrangler` again in a terminal.

### "This deployment already has an operator"

Someone else claimed the deployment first. Only an existing operator can add
you. See [Adding operators](./operator/operators.md#adding-operators).

### "The server did not accept you as the admin"

Either the claim secret was wrong, or the deployment is configured to accept a
different identity.

### "… tenants have not reached local step …"

The deploy is waiting for tenants to finish migrating their data. See
[What a deploy does](./operator/upgrading.md#what-a-deploy-does).
