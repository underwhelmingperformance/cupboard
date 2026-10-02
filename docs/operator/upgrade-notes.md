# Upgrade notes

Most releases upgrade with a plain `cupboard init`, as described in
[Upgrading](./upgrading.md). This page lists the releases that need something
more from you, newest first. If a release isn't listed here, the normal
procedure is enough.

## Next release

These notes apply to the first release after v0.0.35.

### Attestation discovery

The legacy `POST /api/v1/attested-paths` endpoint is removed from default and
named caches. Use `POST /api/v1/attestation-info` for batched discovery of
stored attestation metadata. The CLI uses this interface for
`cupboard attest status` and the publication coverage report.

Clients can use bounded individual attestation-list reads when the server does
not advertise `attestation-info-v1`. Authentication and storage failures remain
errors and do not permit fallback. Discovery does not verify attestation
signatures; use `cupboard attest verify` for verification.

### Simple workflow PR caches

The simple `cupboard-publish.yml` workflow accepts `manage-pr-cache: true` with
an explicit `cache` input. Add `closed` and `reopened` to the caller's
`pull_request` event types, and grant `cache:create`, `cache:close` and
`cache:reopen` for the selected cache. Setup acquires read authority before
creating a missing cache. Existing publication grants and `cache:create` already
imply scoped `cache:read`, which permits the absence response. Private content
requires a `cache:content-read` grant without a root selector. Closed runs skip
builds and publication, including merged pull requests. Existing calls leave
this input disabled.

Newly created PR caches inherit the tenant's default creation grace. A close
expires their roots at the close time, while reads and reuse remain available
through grace. Reopening restores writes. See [Managing PR
caches][simple-pr-caches].

[simple-pr-caches]:
  ../ci/custom-jobs.md#the-simpler-workflow-cupboard-publishyml

### Path deletion and rollback

Complete `cupboard deploy` before deleting a store path. The deployment uploads
both Workers, verifies that both serve the new build, then activates path read
revocation through `0036_path_read_authority_contract.sql`. Changes to shared
NAR and attestation references return a retryable error until the contract step
completes. Resume an interrupted deployment with the same CLI release and
source. If the admin preflight returns an HTTP error, read the Worker logs with
`wrangler tail cupboard --format json`, fix the cause and re-run `cupboard init`
with that release and source.

Both Workers introduce the unbound `PathReadAuthorityRollbackGuard` Durable
Object class. Cloudflare [blocks version rollback] across this class lifecycle
change. After the contract step starts, preceding CLIs also refuse to deploy
against the recorded transition. Recover by completing this deployment. The
contract replaces the preceding reference tables with read-only authority views
and replaces the preceding cache-admission table with an empty view. A preceding
request that has not yet read cache authority is refused before it can serve an
R2 object. A request admitted before contraction may finish under the existing
streaming contract.

After contraction, both Workers must use this release or a compatible successor
that reads the physical storage tables. Preceding Workers cannot admit cache
reads or change cache lifecycle rows. Current public and private cache access is
unchanged. Lifecycle projection can finish before contraction; lifecycle writes
refuse retryably while the contract step runs.

[blocks version rollback]:
  https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/

### Grace defaults for new caches

Deploy the server before using `cupboard cache set-default-grace`,
`clear-default-grace` or `defaults`. Local migration
`0070_cache_creation_defaults` adds a tenant-local creation setting. The initial
setting is no grace, and existing caches keep their current settings.

New caches inherit the setting when creation does not specify grace. This also
applies to implicit creation by publication, root writes or attestation writes.
`cache create --grace` overrides the setting for that cache. Older clients that
explicitly send no grace continue to override the creation default; adopt this
release's CLI and actions when the default should apply to those callers.

Complete any outstanding legacy retention import before creating caches or
changing creation defaults. Creation waits for that import even when the
requested grace is omitted or explicitly disabled, so the import cannot
overwrite a new cache's selected settings.

Delegated tenant administration needs `cache:defaults-read` to inspect the
setting and `cache:defaults-update` to change it. Individual cache grants do not
permit either operation. [Cache creation defaults] describes the commands.

[Cache creation defaults]: ../admin/caches.md#defaults-for-new-caches

### PR cache closure

Deploy this release's server before adopting its CLI or reusable publishing
workflows. Closing a PR now closes its cache on both merged and unmerged close
events. Reads and reuse remain available during the configured grace period; GC
removes expired content and deletes the empty cache after pending work ends.
Reopening explicitly restores write access.

Existing PR trust rules need `cache:close` and `cache:reopen`. Merged close runs
also need a separate closure-only rule because GitHub's signed `ref` changes to
the base branch. The new rule uses a bounded named-cache pattern over the
repository's PR cache family and requires the repository and owner IDs,
`event_name=pull_request`, a base-branch ref and the workflow pin. It does not
grant publication, metadata or content reads, roots or reopening. The new
`cache:close` operation does not imply `cache:read`; an exact lifecycle grant
must include `cache:read` explicitly if its caller also inspects metadata.
Deploy the server before adding this pattern binding.

A `cache:delete` grant does not permit either operation. Run
`cupboard github setup` again with the existing repository, branch and access
choices, and the accepted workflow reference for this release. Confirm
replacement of the PR rule, or use `--yes` for non-interactive setup. To update
a rule manually, add both actions to the same-cache PR grant and preserve its
read, publication, root and attestation grants. Add
`oidc-trust add-github-pr-close` with the same cache template and an immutable
workflow reference for merged closes. The helper refuses branch workflow
references. If the caller deliberately follows a branch, including Cupboard's
`@main` dogfood workflow, add a reviewed manual close-only rule with that exact
workflow selector. See [PR trust rules].

If the calling workflow explicitly lists `pull_request.types`, include both
`closed` and `reopened`. The closed event starts grace; the reopened event
restores writes before publication. See [PR cache lifecycle].

[PR trust rules]: ../ci/trust-rules.md#pull-requests
[PR cache lifecycle]: ../ci/flake-publish.md#using-the-preset

### Refresh credentials

Deploy the server before adopting the new CLI or workflow behaviour. Local
migration `0067_refresh_session_authority` creates the minimal rotation and
replay tables without copying old session authority. Existing access JWTs remain
valid until their normal expiry. Legacy refresh credentials require a new login;
the CLI can use a saved Cloudflare sign-in when that sign-in remains valid.

New refresh credentials include their verified policy identity, authority
ceiling and absolute expiry. Renewal evaluates current trust policy and does not
depend on an originating rule. The server stores the complete credential's hash,
family and generation metadata, and temporarily an encrypted successor
credential for lost-response recovery. [Session renewal] explains the grace
window and policy changes.

Old refresh tables temporarily retain legacy authority for rollback
compatibility. Bounded tenant maintenance removes at most 128 rows from each
legacy refresh table per pass, regardless of expiry. No new session authority is
written to those tables. An expired successor envelope is also cleared in pages
of at most 128 records. Physical removal can take several maintenance passes;
expired credentials and envelopes cannot renew a session during that interval.

A rollback keeps the additive schema, but the preceding server cannot redeem
new-format refresh credentials. Sign in again after a rollback. There is no
session migration or rule-to-session dependency to restore.

[Session renewal]: ../admin/signing-in.md#how-long-a-session-lasts

### CI read acquisition

Deploy this release's Workers before switching callers to this release's
reusable publishing workflows or `actions/setup`, or using
`cupboard run --github-oidc`. Setup requests OIDC read access for a new cache or
a private cache or reuse view without a static credential. Read acquisition uses
a new extension grant at the tenant token endpoint; an older Worker returns
`unsupported_grant_type`. Setup also needs this release's CLI for OIDC-backed
configuration. Existing public read-only jobs continue to run anonymously
without a matching CI trust rule or `id-token: write`.

Custom jobs that read private caches through GitHub OIDC must pass the setup
outputs `read-session-target`, `read-session-view` and `read-session-caches` to
later actions. Pass `read-session-audience` as their `audience` input. Setup now
acquires one read session for all configured caches without static credentials
and the reuse view. Different tenants that need their own netrc pairs on one
deployment host require separate jobs because Nix netrc credentials use the
hostname as the machine key. Complete static credentials in each substituter URL
take precedence over netrc and can coexist with the OIDC session.

Use `oidc-trust add --allow read` to grant cache content reads without
publication or root authority. The GitHub publishing presets accept
`--read-cache`, including `add-github-tag`. A refused private-view probe now
exits 77 and explains how to supply the tenant read credential or OIDC view
authority. Temporary probe failures still exit 75.

### Updating a deployment needs an admin token

- `cupboard init` now needs an admin token to update a deployment that has an
  admin. A CI job that updates a deployment with `CLOUDFLARE_API_TOKEN` alone
  stops before it changes anything. Give the job `--github-oidc`, the
  `id-token: write` permission, and a control trust rule that gives the workflow
  the wildcard grant. See [Updating from CI](./upgrading.md#updating-from-ci).
  In a terminal, `init` signs you in as the admin when it needs to.
- Without an interactive terminal, `init` requires `--cache` and `--access`
  together or neither, even when updating a deployment that already has tenants.
  An update job that supplied only `--access` now exits 2 before deploying.
  Remove both options when the job does not create the first tenant, or supply
  both. See [The first tenant][first-tenant].
- Moving a deployment to a new URL, including adding a first custom domain,
  needs an admin token for the new URL. After a move, runs with `--github-oidc`
  request the new URL as their audience, so pass `--audience` with the old URL
  or add a control trust rule for the new URL. See
  [Moving to a new URL](./deploying.md#moving-to-a-new-url).
- Before routing a new custom domain to a deployment last updated by v0.0.35 or
  earlier, run `cupboard init` once at its current URL. That update records the
  current URL before the domain changes. Then route the new domain and run
  `init --domain <host>`. Existing tenants keep their original issuer and
  audience, so keep their original URLs routed and in caller workflows.
- `init` refuses a plan that selects a D1 database other than the deployed
  Workers' database if either database records an admin. See
  [Changing the control database](./deploying.md#changing-the-control-database).
- If the control Worker of a claimed deployment was deleted, `init` can't update
  the deployment until you redeploy the control Worker with Wrangler. See
  [If the control Worker was deleted](./deploying.md#if-the-control-worker-was-deleted).
- Deployment plans now use the existing control Worker's resource names and cron
  triggers. Older CLIs could select new, empty resources when release defaults
  changed. If an earlier update did that, recover the original names in the plan
  menu. When either database records an admin, first rebind the control Worker
  to the original database, then run `init` as that database's admin. See
  [Resource names][resource-names] and [Changing the control database].

[first-tenant]: ./deploying.md#the-first-tenant
[resource-names]: ./deploying.md#resource-names-and-cron-triggers
[Changing the control database]: ./deploying.md#changing-the-control-database

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
  keeps the `deployment_phase` row up to date for v0.0.34 and v0.0.35. The
  independent `deployment-transitions` transition creates that table with
  migration `0031`; it has no contract migration. See
  [What a deploy does](./upgrading.md#what-a-deploy-does).
- The independent `attestation-path-index` transition applies migration `0032`
  to index attestation references by tenant, store-path hash and generation. The
  index is applied during contract, after the earlier cache identity transition
  has rebuilt the reference table. Neither `0031` nor `0032` requires a separate
  operator command; `init` records their progress.
- The `deployment.transitions` control procedure replaces `deployment.phase`.
  Use `cupboard deployment status` and `cupboard deployment resume` from the
  same release as the deployed control Worker. The `--output-mode json` output
  of both commands changes: the `deployment-status` result has `transitions`,
  `unrecognised` and `required` in place of `phase`. Both `deployment-status`
  and `deployment-readiness` include the new status fields below. Their
  `current` field now reports the server build's final local step; `required`
  specifies the step used for the readiness counts. Previously, `current`
  reported the step requested by the CLI. Counts still include both active and
  suspended tenants, as they did in v0.0.35.
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

### NixOS and Home Manager modules

The modules keep the same `nix.cupboard.caches` interface. Public cache URLs and
all trusted keys are now appended through `nix.extraOptions`, after
`nix.settings` and the user's own `nix.extraOptions`. They are no longer
included in the evaluated `nix.settings.substituters` and
`nix.settings.trusted-public-keys` options. Update configuration that reads
those options if it needs to include Cupboard caches or keys. Nix still reads
the appended values from `nix.conf`. See [NixOS module configuration].

Private cache files now use `!include`, so a missing or unreadable file can
silently remove the private cache from the substituter list. Check the cache
after creating or moving the file, and keep every parent directory searchable by
accounts that read the including `nix.conf`. If a parent directory cannot be
searched, Nix can ignore the whole including file for that account. See [Private
module credentials].

[NixOS module configuration]: ../use/nix-clients.md#nixos-and-nix-darwin
[Private module credentials]: ../use/private-caches.md#nixos-and-home-manager

### Tenant lifecycle commands

Retrying `tenant create` compares the owner's issuer exactly, including a
trailing slash. A differently spelled issuer now returns HTTP 409 instead of
matching the existing tenant. Reuse the original issuer on retries; this does
not change an existing tenant's issuer.

`tenant suspend` and `tenant resume` now return HTTP 409 when removal is already
in progress. They cannot interrupt or reverse offboarding. Once removal
finishes, both commands return HTTP 410. See [Removing a tenant].

[Removing a tenant]: ./tenants.md#removing-a-tenant

### Background retry limits

Upload verification, publication recovery and attestation inheritance now stop
after twelve failed attempts or 24 eligible hours. The eligible clock starts
with the first attempt after the required migrations finish, includes active
backoff time and excludes suspension. Client retries preserve the budget.

D1 migration `0037_tenant_retry_clock` adds the clock fields and status triggers
before the Workers are uploaded. Existing active tenants start their clock on
the first retry-clock read. Suspended tenants start when resumed. The migration
does not rewrite existing tenant rows, so it can expand while path read
authority is waiting for contraction.

The retry migration resets the old inheritance attempt counter once. Earlier
servers incremented that counter before work, including attempts that made
progress or ran out of subrequests, so its value did not count failures. Upload
failure counts remain unchanged. Stored provider error text is replaced with a
controlled category. Exhausted inheritance diagnostics expire after seven days,
while the current narinfo generation retains its exhausted state. See
[Background failures] for retry delays and cleanup behaviour.

[Background failures]: ./running.md#maintenance-failures

### Exit statuses and output

These changes affect scripts that check the CLI's exit status or parse its text
output. [Scripting the CLI](../reference/cli-scripting.md) lists the exit
statuses.

- Terminal output and GitHub log groups, annotations and result rows now go to
  standard error. Scripts that parse results should use `--output-mode json` and
  read standard error, or use `--result-file`. `pubkey` and `config` still write
  their data to standard output, as do `--help` and `--version`. `run` still
  forwards its child's streams directly.
- Prompts require terminal mode and terminals on both standard input and
  standard error. Capturing standard output still permits prompts; redirecting
  standard error disables them. `CI=true` also disables prompts. See
  [Confirmation prompts][confirmation-prompts].
- `cupboard run` exits 127 for a missing child executable. GitHub OIDC
  acquisition exits 77 for unavailable or refused authority and 75 for temporary
  failures or malformed token responses. These failures used to exit 1. The
  child's own status and output remain unchanged.
- Non-interactive deployment without `--yes`, or without `--account` when
  several accounts are available, exits 2. These missing options used to exit 1.
- `github check --fix` exits 69 when all unresolved jobs are unverified and no
  automatic repair is available. It used to exit 1. A failed check still
  exits 1.
- OAuth token exchanges that refuse an identity, refresh token or requested
  authority exit 77 even when the endpoint responds with HTTP 400. Malformed
  token requests or grant details exit 2. These failures used to exit 1.
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

[confirmation-prompts]: ../reference/cli-scripting.md#confirmation-prompts

### CLI option spellings

Existing flags and positional arguments remain accepted. `github setup` accepts
`--access` as an alias for `--cache-access-mode`, and still applies that mode to
pull-request caches and their reuse view. `--workflow-ref` and
`--job-workflow-ref` are aliases on `github setup`, `github check` and the
tenant trust-rule commands. `init --tenant` is an alias for `--cache`, which
specifies the first tenant's slug, not a named cache.

`tenant set-quota` also accepts `--quota-bytes`, as on `tenant create`. Use
either the positional byte count or the option; supplying both exits 2 before
authentication. Zero remains a zero-byte limit; `clear-quota` removes the limit.

### JSON result compatibility

`control-oidc-trust list` can include unreadable entries in its
`oidc-trust-rules` result. Each has only `id`, `disabled` and
`unreadable: true`; it has no `issuer`, `claims` or `permittedGrants`. Check
`unreadable` before reading those fields.

The `attestation-verification` result from `attest verify` adds
`trust.acceptingRoot` to each verified bundle. The `github-setup` result can
include a `pull-request cache access` step when existing pull-request caches
have a different access mode from the selected mode.

Grant objects also support the `cupboard_view` type and the
`cache:content-read`, `view:content-read`, `tenant:read-quota` and
`tenant:set-quota` actions. Update consumers that validate grant types, actions
or result fields against a fixed list.

### Adding trust rules from a file

- `cupboard control-oidc-trust add` takes the whole rule from `--from-file`,
  which it now requires. It no longer accepts `--issuer`, `--audience` or any
  other rule option. The command already took the rule from the file, so remove
  the other options from existing invocations.
- `cupboard oidc-trust add --from-file` refuses `--issuer`, `--audience` and the
  other rule options, which it used to ignore. Remove them from invocations that
  use `--from-file`.

### Choosing cache access in CI

Read credentials no longer choose whether a new CI cache is public or private.
New caches inherit the tenant's default cache access unless `cache-access-mode`
specifies `public` or `private`. Existing caches keep their access, and an
explicit mode that disagrees with an existing cache fails.

The earlier flake workflow created private pull-request caches when
`fallback_read_user` was supplied, and public caches otherwise:

- With a public default cache, set `cache-access-mode: private` if the caller
  previously used the read credential to select private pull-request caches.
- With a private default cache, set `cache-access-mode: public` if the caller
  previously omitted the credential to select public pull-request caches.

`github setup --read-user` no longer selects private access for the reuse view.
Pass `--cache-access-mode public` or `--cache-access-mode private` to select
access for new pull-request caches and the view; without it, setup uses the
default cache's access. Use the same mode in the reusable workflow. Existing
caches and views are not changed automatically. Resolve any access mismatch
before running setup again. See [Private caches in CI][private-caches-ci].

Custom jobs that use `actions/setup` can continue to pass
`provision-cache-access`; it is a deprecated alias applied only when
`provision-cache` is set. Setup warns when this alias is supplied. Use
`cache-access-mode` to require access for an existing cache without
provisioning.

[private-caches-ci]: ../ci/private-caches.md#choose-the-cache-access

### Static read secrets in the flake workflow

The flake workflow accepts `read_user` and `read_password` as its default static
read credential pair, and `private_substituters` as a list of additional private
cache URLs with complete URL credentials. A private reuse view needs the tenant
read credential. `destination_read_user` and `destination_read_password` still
override the pair for the destination cache.

`fallback_read_user` and `fallback_read_password` remain deprecated aliases for
`read_user` and `read_password`. Supply both members of each pair or neither.
When both pairs are supplied, their usernames and passwords must match or the
workflow fails during input validation. Migrate callers to the `read_*` pair.
See [Optional static read credentials][static-read-secrets] for the current
inputs and examples.

[static-read-secrets]: ../ci/private-caches.md#optional-static-read-credentials

### Choosing what CI builds and publishes

The reusable workflows use four separate inputs: `build` chooses whether to
rebuild requested outputs, `substituter` chooses whether externally substituted
outputs are selected for publication, `publish` chooses the published path set,
and `attest` enables build provenance. Both workflows default to
`build: missing` and `attest: true`. The flake workflow defaults to
`substituter: leave` and `publish: built`, which publishes selected outputs plus
observed build intermediates. The simpler workflow defaults to
`substituter: copy` and `publish: outputs`.

| v0.0.35 caller                                                                                                   | Change for this release                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flake workflow with `push: false`                                                                                | No input change is required. `push: false` disables publication and signing. `publish: none` also disables them. Add `build: rebuild` if the run must build every requested output again.                                             |
| Flake workflow with `push: true` or no `push` input                                                              | The defaults publish selected outputs plus observed build intermediates. An available output is no longer rebuilt just because its attestation is missing. Add `build: rebuild` if the job must execute every requested output again. |
| Simple workflow with `attest: false`                                                                             | No change is required. The input remains a boolean.                                                                                                                                                                                   |
| Simple workflow with `attest: true` or no `attest` input, when every output needs build provenance from this run | Add `build: rebuild`. Dependencies may still be substituted.                                                                                                                                                                          |

The new flake-workflow `attest` input is also a boolean and defaults to `true`.
Both workflows sign build provenance only for builds observed on the runner.
Reused or substituted outputs receive no fresh build claim. The destination can
inherit eligible existing attestations without changing the original bundles or
signatures. Signing and attachment still happen after publication. If either
fails, the workflow fails, but the paths remain in the cache. A rerun that
reuses those paths does not recreate build evidence for the earlier attempt.

Custom jobs should replace `require-provenance: true` on `actions/build-paths`
with `build: rebuild`. The deprecated input still selects `rebuild` when `build`
is omitted. An explicit `build: missing` conflicts with
`require-provenance: true` and fails before building. Remove the deprecated
input and set `build: rebuild` to preserve the execution guarantee.
`require-provenance: false` uses the selected build mode, which defaults to
`missing`. Dependencies can still be substituted, and execution on a remote
builder does not establish runner-local provenance.

Custom jobs should set `inline-bundles: false` on `actions/attest`, pass
`steps.attest.outputs.bundles-file` to the `bundles-file` input of
`actions/attest-attach`, and run attachment when that file output is not empty.
The manifest includes every bundle. The `bundles` and `bundle-path` outputs
remain complete when `inline-bundles` is `true`, which is the default. File mode
omits these inline outputs explicitly.

Each `actions/attest` invocation now uses unique directories for default subject
files and signing outputs. Use the `checksums-file` and `bundles-file` outputs
to find the resulting files. Replace references to the former fixed
`$RUNNER_TEMP/cupboard-attest/bundles.txt` manifest path with `bundles-file`.

`actions/attest` signs SLSA build provenance for observed local builds and SCAI
`REPRODUCIBLE` assertions for successful local verification rebuilds. Its
`predicate-file` input chooses where to write that reproduction report. The
`origin-bundle-path` output lists the signed SCAI bundles when `inline-bundles`
is `true`; it is empty when no output was reproduced. All signed bundles are
listed in `bundles-file`. The action no longer generates build-origin statements
or new reports about inherited bundles. Existing signed bundles, including
build-origin and SCAI reports, remain attachable and independently verifiable.

For build output lists, set `inline-paths: false` on `actions/build-paths` and
pass `steps.build.outputs.publish-paths-file` to `actions/push` through its
`paths-file` input. Files avoid the process argument and Actions output limits
for large lists. The reusable workflows already use files for both lists.

The CLI uses grouped attachment when the server supports it: each distinct
bundle is uploaded once, then its subjects are attached in pages. With an older
server, the CLI uses the existing per-path attachment API. That fallback uploads
the same signed bundle for each path and preserves its subjects and signatures.
Ordinary publication jobs do not need a server upgrade for multi-subject
attachment.

Attestation attachment now matches subjects by their NAR digest. A subject can
omit its name or use a descriptive name that differs from the store-path
basename. Every selected path with matching NAR bytes can receive the bundle;
selected-path authorisation and committed NAR identity checks still apply.

`cupboard attest attach` accepts `--paths-file` and `--attestations-file` for
lists of store paths and bundle files, respectively. Each file contains one path
per line. `actions/attest-attach` passes these files to the CLI so large lists
do not depend on command-line or environment-variable limits.

For remote rebuilds, use `store: ssh-ng://...` to select the machine. Delegated
builders cannot guarantee execution because Nix can reuse an output already on
the builder. A cohort with `remote: true` and no `store` cannot use
`build: rebuild`; planning rejects this combination before any cohort builds or
publishes. Use `build: missing` to keep delegated reuse, or select the remote
store directly. The selected store must have local build slots and support the
target's system and required features. Cupboard disables onward dispatch for
rebuilds and checks observed execution independently of attestation signing.

`build: rebuild` builds each requested output again in the selected Nix store,
even if the output is already available. Nix may still substitute dependencies.
The workflow signs SLSA provenance only for builds observed on the runner. A
delegated builder or selected remote store does not provide that evidence.
`publish: closure` also publishes every runtime reference of each selected
output that reaches the cache, including substituted dependencies. Setting
`publish: none` skips signing whatever `attest` specifies. See [Choosing
publication behaviour][publication-behaviour] and [the simpler
workflow][simpler-workflow] for examples and the full interaction table.

[publication-behaviour]: ../ci/flake-publish.md#choosing-publication-behaviour
[simpler-workflow]:
  ../ci/custom-jobs.md#the-simpler-workflow-cupboard-publishyml

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
