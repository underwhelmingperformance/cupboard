# Trust rules

This document explains how a CI push authenticates to a tenant and what a trust
rule matches. It also explains how to write a rule directly when no preset
matches the required provider or claim shape. The setup steps for the common
rules are in [docs/github-actions.md](./github-actions.md).

A push from CI exchanges its GitHub Actions OIDC token for a cupboard token. The
exchange succeeds only when a trust rule on the tenant both recognises the token
and permits everything the push asks for. The exchange is all-or-nothing: if the
push wants to attach attestations or set a retention root and the rule does not
grant those, the whole exchange is refused, not narrowed.

Every claim comparison is exact: a rule value is matched against the token's
claim as a literal string, so `@refs/heads/main` and `@main` are different
values, and a rule value that differs from the claim in a real token never
matches.

## Pinning identity

A good rule pins identity on two axes. The repository is pinned by its immutable
numeric ids (`repository_id` and `repository_owner_id`), so renaming the
repository cannot silently transfer trust, and whoever later takes the freed
name does not inherit the tenant's trust. The trigger is pinned by the `ref`
claim, which identifies the branch, tag, or pull request that started the run.
Optionally, `job_workflow_ref` can also restrict the workflow file.

## The presets

The `add-github-pr` and `add-github-branch` commands assemble these rules for
the common cases.

`add-github-pr` trusts pull-request builds. It routes each build to its own
short-lived cache, `gh-<repository-id>-pr-<number>`, and to the matching
retention root, `github:<owner>/<repo>/pr-<number>/`. Both are keyed on the
pull-request number, so one pull request cannot reach another's paths. The cache
name also includes the repository, because a tenant can serve several
repositories and their pull-request numbers repeat. The repository component
comes from `repository_id`, a claim the issuer signs, so the rule produces
exactly one cache name. A token cannot select a cache for another repository.

The default root template is `github:<owner>/<repo>/pr-{pr}/`, independently of
`--cache-template`. To customise both names, pass `--root-template` as well.

`add-github-branch` trusts pushes to one branch and publishes to the tenant's
default cache, under `github:<owner>/<repo>/<branch>/`, which is the retention
root the push action writes by default. It pins the branch through the `ref`
claim, so a sibling branch that shares a reusable workflow does not match.

Both commands look up the repository's ids for you and grant the push, every
retention operation a run performs on its roots, and attestation. Pass
`--no-attest` to withhold attestation, or `--root-template` to override the
root.

```bash
# Per-PR rule: build the pull request, push to its own cache.
cupboard oidc-trust add-github-pr https://cupboard.example.workers.dev/t/acme \
  --repo acme/infra

# Branch rule: pushes to main, requiring the reusable publish workflow,
# publish to the default cache.
cupboard oidc-trust add-github-branch https://cupboard.example.workers.dev/t/acme \
  --repo acme/infra --branch main \
  --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@0123456789abcdef0123456789abcdef01234567
```

`--job-workflow-ref` is optional on both presets. It restricts the rule by the
`job_workflow_ref` claim, which identifies the workflow file that issued the
token as `owner/repo/path@ref`. Include `@ref` for an exact match. For routine
cupboard releases, use the `refs/tags/v*` pattern described below.

A ref of `refs/tags/<glob>` with `*` wildcards is a tag pattern. The rule
accepts the workflow file at every matching tag, including tags created later.
For example, `v*` accepts every release tag. The repository's tag publishers are
therefore part of the trust boundary. Omitting `@ref` produces a deliberately
weaker rule that accepts the file from every branch and release. In that case
only the `ref` claim restricts which branch or tag the run came from.

The option follows the claim name because `job_workflow_ref` differs from
`workflow`, which contains the workflow name, and `workflow_ref`, which
identifies the calling workflow.

## Reusable workflows

When a repository calls a reusable workflow, the jobs belong to the reusable
workflow while the standard repository and ref claims still describe the caller.
A trust rule that restricts `job_workflow_ref` must therefore name the file in
the repository where the reusable workflow lives, and must keep its caller
repository and ref restrictions as well. For cupboard's own workflow that claim
is
`underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*`.
[GitHub documents this called-workflow claim][github-oidc-reusable-workflows]
separately from the standard caller claims.

[github-oidc-reusable-workflows]:
  https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows

Reference cupboard's reusable workflows by an immutable published release tag.
The caller selects one reviewed release, and a `refs/tags/v*` rule is written
once and accepts every later release tag. A pull request cannot gain access by
adding an edited copy of the publication job, and moving to a later release
needs no tenant change. Anyone who can publish a cupboard release tag is
therefore inside the tenant's trust boundary. Set `cupboard-version` only when
you deliberately want to run a release other than the one the workflow is pinned
to.

A tenant can instead trust the full commit SHA or exact release tag from the
caller. That narrower policy requires a tenant administrator to add trust for
each release before the caller is updated.

## Writing a rule directly

For an issuer or claim shape the presets do not cover, the general
`cupboard oidc-trust add` takes the issuer, audience, claims and grants
directly. `--job-workflow-ref` sets the `job_workflow_ref` claim without
spelling out `--claim`, and omitting `--cache` scopes the grant to the tenant's
default cache:

```bash
cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cupboard.example.workers.dev/t/acme \
  --claim repository=acme/infra \
  --claim ref=refs/heads/main \
  --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@0123456789abcdef0123456789abcdef01234567 \
  --allow push --allow attest --allow root \
  --root github:acme/infra/main/
```

The repository and ref claims restrict this grant to runs on `acme/infra`'s main
branch. The pinned `job_workflow_ref` identifies the reusable workflow, not the
caller's repository or branch.

The trailing slash on the root makes it a prefix, so one grant covers every
per-system root beneath it.

The root selector also limits `root:list` to the targets of matching roots.
`cupboard root list` lists roots across the cache and therefore requires
authority without a root selector.

## The run-root grant

A build-time push may bind a run root when it negotiates its token. Every path
the push commits is then attached under that root's name and retained for the
root's own time-to-live. Attaching is its own operation, `root:attach`, granted
by the `attach` shorthand. The presets include it; a rule created with `add`
must name it explicitly. Like `root`, it binds a root selector, so give the rule
the exact name or trailing-slash prefix the run roots will use:

```bash
cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cupboard.example.workers.dev/t/acme \
  --claim repository=acme/infra \
  --claim ref=refs/heads/main \
  --allow push --allow attest --allow root --allow attach \
  --root github:acme/infra/main/
```

A push that names both a target root and a run root asks for two grants on the
same cache, one per root selector. Rule selection first finds the
highest-precedence set of rules for the verified identity. The requested grants
can distinguish rules tied at that precedence only when exactly one rule permits
the complete request. Rules are never combined, so one rule must permit both
grants. If the target-root and run-root allowances are split across two rules,
neither rule permits the complete exchange.

This allows two rules with the same identity claims to grant disjoint authority,
such as access to different caches. If two tied rules both permit a request, the
exchange remains ambiguous and is refused. A less specific identity rule cannot
grant a request that the highest-precedence rules refuse.

The exchange is all-or-nothing, so a rule that cannot grant both refuses the
whole exchange. That is the safer failure: the push fails at token exchange
rather than publishing successfully with no retention.

## Creating and removing a cache from CI

The `create` and `remove` shorthands grant `cache:create` and `cache:delete` on
the cache a rule binds. The `add-github-pr` preset includes both, together with
the upload, root and attestation permissions used by the publication workflow.
It pins the repository and owner IDs and the pull-request event:

```bash
cupboard oidc-trust add-github-pr "$tenant" --repo acme/infra \
  --job-workflow-ref 'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*'
```

The workflow restriction has the release-publisher trust implications described
above. The rule renders the cache name from the verified token's `repository_id`
and `ref` claims. A token for pull request 7 of the authorised repository 1234
can create or remove `gh-1234-pr-7`. A missing or unmatched `ref` cannot render
a cache name, so token exchange returns 400.

A run can authenticate these commands with its own OIDC token:

```bash
cupboard cache create "$tenant" "gh-$repository_id-pr-$number" \
  --github-oidc --if-absent --access public --root-ttl 14d
cupboard cache remove "$tenant" "gh-$repository_id-pr-$number" \
  --github-oidc --force --yes
```

Create the cache explicitly to choose its access and default root TTL before
publication. A first push can also create a missing cache, but it inherits the
default cache's access and has no default root TTL. The flake publish workflow
invokes creation from its plan job before publishing. A closed event removes the
cache only if the pull request was not merged. Merged caches remain available to
the branch run through the reuse view, and their roots expire according to their
TTL. All closed events skip planning and building. The caller must include
`closed` in its `pull_request` trigger for the removal job to run.

The workflow requests private access when `fallback_read_user` is set and public
access otherwise. `cupboard github setup` makes the same choice for a new reuse
view from its `--read-user` input. Supply consistent credentials to both. Setup
reports an existing view with different access as drift and leaves it unchanged;
`--if-absent` also leaves an existing cache's access and retention unchanged.

A default root TTL lets roots expire even if a later writer supplies no TTL.
Collection can then reclaim paths that have no other retention. An abandoned
pull request does not have to run a deletion job for those paths to expire. The
empty cache row remains until it is removed. Choose a TTL that covers the
required reuse period; a later push refreshes the roots it updates.

## The flake publish workflow's grants

The flake publish workflow depends on that prefix. Each of its jobs exchanges
its own OIDC token under the same trust rule: the plan job ensures a retention
root for each already-cached target, and the cohort jobs push and attest. Every
root the workflow writes, one per target plus the shared per-run root, is
beneath the `root-prefix` the caller passes, so a single prefix grant covers
them all. Trust the workflow with the branch preset, pinning `job_workflow_ref`
to cupboard's reusable file:

```bash
# Trust main's flake publish. The preset grants github:acme/app/main/, a
# prefix covering every per-target and shared-output root the run writes.
cupboard oidc-trust add-github-branch https://cupboard.example.workers.dev/t/acme \
  --repo acme/app --branch main \
  --job-workflow-ref underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*
```

Then call the workflow with a `root-prefix` that nests under the granted root,
here `github:acme/app/main` beneath the grant `github:acme/app/main/`:

```yaml
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@vX.Y.Z
    permissions:
      attestations: write
      contents: read
      id-token: write
    with:
      url: https://cupboard.example.workers.dev/t/acme
      root-prefix: github:acme/app/main
```

The `job_workflow_ref` names the file in `underwhelmingperformance/cupboard`,
where the reusable workflow lives, not the caller's repository. The plan and
build jobs run inside cupboard's workflow, so their tokens carry cupboard's file
in `job_workflow_ref`. The caller is still pinned, by the repository ids and the
`ref` claim the preset sets.

## Release caches

`add-github-tag` captures the tag from the workflow token. By default, it uses
the tag for both the cache name and the retention-root suffix. To give users one
substituter URL for every release, use a fixed cache and keep the tag only in
the root:

```bash
cupboard oidc-trust add-github-tag https://cupboard.example.workers.dev/t/acme \
  --repo acme/infra \
  --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main \
  --cache-template releases \
  --root-template 'github:acme/infra/{tag}/'
```

The cache serves every release path at `/cache/releases`. The distinct roots
retain each tag independently, so publishing a later version does not release an
earlier version's paths.

## Capture rules

For a provider or claim shape without a preset, `--capture` reads a value from a
token claim using a pattern with a named group. The captured value fills the
matching `{...}` placeholders in `--cache-template` and `--root-template`. The
pattern also filters tokens: a token whose claim does not match is refused.

## Pushing to a private cache

A grant identifies a cache by scope, independent of whether reads are public or
private. To grant writes to the private cache `ci`, pass `--cache ci`:

```bash
cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cupboard.example.workers.dev/t/acme \
  --claim repository=acme/infra \
  --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main \
  --cache ci \
  --allow push
```

Changing `ci` between public and private access does not create a second cache
and does not need a new trust rule. A rendered `--cache-template` must be a
valid cache name, and the captured value selects the same cache whatever its
access.

A trust rule governs writes. Reads are separate: a reader of a private cache
presents the tenant-wide fallback credential, or the cache's own credential when
it has one. Trust rules do not grant read credentials. See [Private
caches][nix-cache-access].

[nix-cache-access]: ./nix.md#private-caches
