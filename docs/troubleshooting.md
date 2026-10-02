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

### Nix gets a 404 for a NAR that the narinfo lists

The cache still has a narinfo that records a NAR URL whose file has gone
missing. Push the path again. Upload negotiation detects the missing NAR and
requests a replacement in that push. Maintenance rewrites the narinfos in other
caches that shared the old NAR URL. Those caches can return a NAR 404 until the
rewrite completes. See
[When a cache has lost a NAR](./ci/how-it-works.md#when-a-cache-has-lost-a-nar).

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

To run a build command, `build-push` needs to set Nix's `post-build-hook`, and
only users that the Nix daemon trusts can do that. Add your user to the daemon's
`trusted-users`. For a list of installables in `--cohorts-file`, `build-push`
doesn't stop: it publishes the outputs after the build finishes, and prints
`Publication mode: after the build`. See
[What `build-push` needs](./admin/pushing.md#what-build-push-needs).

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
fails. See [Check the setup](./ci/quickstart.md#5-check-the-setup) and
[Checking publishing jobs](./ci/github-check.md).

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

An exchange without explicit grants requires one matching rule. If equally
specific rules match, request explicit grants or distinguish the rules' identity
constraints.

### "The requested authorization_details are not permitted"

The preferred matching trust rules do not permit every action that the job
requested. For example, the job might need `root:set` for its target root,
`root:attach` for its run root, or `attestation:attach`. Add the missing grant
to an eligible rule. Grants can compose within the preferred identity group, but
a less preferred rule cannot supply missing authority. See
[When several rules match](./ci/trust-rules.md#when-several-rules-match).

### The preset fails the run

The `pull-request-and-branch` preset fails pull requests from forks. It also
fails runs on any branch other than the one set in `branch`. Skip fork pull
requests with the `if:` condition shown in
[Add the workflow](./ci/quickstart.md#4-add-the-workflow), and limit the
workflow's triggers to pull requests and that branch.

### A tag publish can't find its cache

The first push to a named cache creates the cache, with the access of the
tenant's default cache. When the workflow also uses a reuse view, though, its
setup step reads the destination cache's `nix-cache-info` before anything is
published, and fails if the cache doesn't exist yet. Create the cache before the
first tag run in that case, or when you want to choose its access or default
root TTL:

```sh
cupboard cache create https://cupboard.example.workers.dev/t/acme v1.2.3 \
  --access public
```

See [Publishing releases](./ci/flake-publish.md#publishing-releases).

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

### "Stored tenant state differs from what github setup would write"

`cupboard github setup` never replaces a trust rule or a reuse view that already
exists. For example, `--cache-access-mode private` can conflict with a public
view that setup created earlier. Without an explicit mode, new pull-request
caches inherit the tenant default cache's access. Change or remove each item
that the message lists, then run setup again. For the reuse view, see [Choose
the cache access][ci-cache-access].

[ci-cache-access]: ./ci/private-caches.md#choose-the-cache-access

### A private cache refuses the credential

If a cache has its own static credential, the tenant's static credential does
not read it. Pass the cache's pair in `destination_read_user` and
`destination_read_password`, or omit static credentials and authorise the job's
exact `cache:content-read` grant. A private reuse view accepts a tenant static
credential through `read_user` and `read_password`, or a Cupboard read token
with the exact `view:content-read` grant. A supplied static pair takes
precedence, so a rejected pair does not trigger an OIDC retry. See [Private
caches in CI][ci-private-caches].

[ci-private-caches]: ./ci/private-caches.md

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

- An aggregate has more than 149 components. The planner limits each aggregate
  to 149 components. Split the aggregate into smaller ones.
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

### "Deployed, but the deployment … has no admin"

The Workers were deployed, but nobody claimed the deployment, so nobody can
create a cache yet. The message says why:

- The run had no terminal. The claim needs a sign-in from a terminal, whichever
  Cloudflare credential the deploy used. Run `cupboard init` from a terminal.
- The deploy stopped before the claim, for the reason printed above it. Fix that
  reason, then run `cupboard init` from a terminal.
- The claim failed with a server error. The deploy prints the control Worker's
  log for the request when Cloudflare has it.

The next `cupboard init` from a terminal sets a fresh claim secret and claims
the deployment. See
[When the claim doesn't happen](./operator/deploying.md#when-the-claim-doesnt-happen).

### "The admin claim failed"

The deployment refused the claim. The advice after the message depends on the
last response from `/signup`:

- 409: someone else is already the admin. Sign in as that admin with
  `cupboard login <deployment URL>`, adding `--oidc-issuer` and `--client-id` if
  the admin claimed with another issuer or client, and run `cupboard init`
  again. If you aren't the admin, ask the admin to
  [add you as an operator](./operator/operators.md#adding-operators).
- 400: the deployment rejected your ID token or the request. The message
  includes the server's reason. Sign in with an issuer and client whose ID
  tokens meet the conditions in
  [Signing in for the claim](./operator/deploying.md#signing-in-for-the-claim).
- 429: Cloudflare limited the rate of requests. Wait a few minutes and run
  `cupboard init` again.
- A 5xx status: the control Worker failed. The deploy prints its log for the
  request when Cloudflare has it.
- 403, repeated: the claim secret didn't take effect on the Worker in time. Run
  `cupboard init` again, which claims with a fresh secret.
- Any other status: check that the URL serves this release's control Worker.
- No response: the deploy couldn't reach the deployment. Check that it serves at
  that URL.

### "This deployment is administered by … Updating it needs an admin token"

The deployment has an admin, and the deploy has no usable admin token. Nothing
was changed. The message says why, for example that this machine has no session,
or that the token lacks the wildcard grant.

- In a terminal, sign in as the admin with the `cupboard login` command that the
  message prints, then run `cupboard init` again.
- In CI, pass `--github-oidc`, with a control trust rule that gives the workflow
  the wildcard grant. See
  [Updating from CI](./operator/upgrading.md#updating-from-ci).
- If you signed in as the admin and the token still lacks the wildcard grant,
  the admin's control trust rule no longer gives it. See
  [Restoring the admin's wildcard grant](./operator/operators.md#restoring-the-admins-wildcard-grant).

### "The plan selects the D1 database …"

The plan selects a database other than the deployed Workers' database, and one
of the two records an admin. Select the current database in the plan, or bind
the control Worker to the other database first. See
[Changing the control database](./operator/deploying.md#changing-the-control-database).

### "… no longer exists, so no Worker can check an admin token"

The control Worker of a claimed deployment was deleted. Redeploy it with
Wrangler, as described in
[If the control Worker was deleted](./operator/deploying.md#if-the-control-worker-was-deleted),
then run `cupboard init` again.

### "… tenants have not reached local step …"

Tenants haven't finished migrating their data. When the message goes on to say
that none of them is classified as working ten minutes after the wake, the
deploy or `cupboard deployment resume` stopped waiting, and the message lists
the stalled tenants with their errors and the tenants that haven't been woken
yet. Tenants that are still making progress keep going. Repair the errors that
the message lists, then run `cupboard deployment resume`. See
[When a deploy stops before finishing](./operator/upgrading.md#when-a-deploy-stops-before-finishing).

### "The deployment records that the contract migrations of transition … have started"

You're deploying an older release over a deployment that a newer release has
upgraded, and the newer release has started removing schema that the older one
may need. Stay on the deployed release. See
[Deploying an older release over a newer one](./operator/upgrading.md#deploying-an-older-release-over-a-newer-one).
