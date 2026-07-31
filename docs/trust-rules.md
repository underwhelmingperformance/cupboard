# Trust rules

How a CI push authenticates to a tenant, what a trust rule matches, and how to
write rules the presets do not cover. The setup steps that create the common
rules are in [docs/github-actions.md](./github-actions.md).

A push from CI exchanges its GitHub Actions OIDC token for a cupboard token. The
exchange succeeds only when a trust rule on the tenant both recognises the token
and permits everything the push asks for. The exchange is all-or-nothing: if the
push wants to attach attestations or set a retention root and the rule does not
grant those, the whole exchange is refused, not narrowed.

Every claim comparison is exact: a rule value is matched against the token's
claim as a literal string, so `@refs/heads/main` and `@main` are different
values, and a rule whose spelling differs from the claim a real token carries
can never match.

## Pinning identity

A good rule pins identity on two axes. The repository is pinned by its immutable
numeric ids (`repository_id` and `repository_owner_id`), so a rename cannot
silently transfer trust and nobody reusing the freed-up name inherits it. The
trigger is pinned by the `ref` claim, which is the branch (or pull request) that
started the run, so only that branch's pushes are accepted. Optionally the
workflow file is pinned too, by `job_workflow_ref`, as a further restriction.

## The presets

The `add-github-pr` and `add-github-branch` commands assemble these rules for
the common cases. `add-github-pr` trusts pull-request builds and routes each one
to its own short-lived cache (`pr-<number>`) and matching retention root
(`github:<owner>/<repo>/pr-<number>/`), both keyed on the pull-request number,
so one PR cannot reach another's paths. `add-github-branch` trusts pushes to one
branch and publishes to the tenant's default cache under the retention root the
push action writes by default, `github:<owner>/<repo>/<branch>/`; it pins the
branch through the `ref` claim, so a sibling branch sharing a reusable workflow
cannot match. Both look up the repository's ids for you, grant the push and the
retention root, and grant attestation by default; pass `--no-attest` to withhold
it, or `--root-template` to override the root.

```bash
# Per-PR rule: build the pull request, push to its own pr-<n> cache.
cupboard oidc-trust add-github-pr https://cupboard.example.workers.dev/t/acme \
  --repo acme/infra

# Branch rule: pushes to main, requiring the reusable publish workflow,
# publish to the default cache.
cupboard oidc-trust add-github-branch https://cupboard.example.workers.dev/t/acme \
  --repo acme/infra --branch main \
  --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main
```

`--job-workflow-ref` is optional on both presets and restricts the rule further
to the `job_workflow_ref` claim, the workflow file that issued the token,
written `owner/repo/path@ref`. Give it with an `@ref` to match exactly: for
`cupboard-flake-publish.yml` that is the release tag the caller pins, and for
`cupboard-publish.yml`, which callers reference at `main`, it is
`refs/heads/main`. A ref of `refs/tags/<glob>` with `*` wildcards is a tag
pattern: the rule accepts the file at every tag the glob admits (`v*` for any
release), including matching tags created in the future. The repository's tag
publishers are therefore part of the rule's trust boundary. Given without an
`@ref` it matches that file at any ref, a deliberately weaker rule: every branch
and release copy of the file is accepted, and only the `ref` claim still pins
what was built. It is named after the claim on purpose: `job_workflow_ref` is a
different claim from `workflow` (the workflow's name) and `workflow_ref` (the
calling workflow).

## Reusable workflows

When a repository calls a reusable workflow, the jobs belong to the reusable
workflow while the standard repository and ref claims still describe the caller.
A trust rule that restricts `job_workflow_ref` must therefore name the file in
the repository where the reusable workflow lives, for cupboard's own workflow
`underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/vX.Y.Z`
at the release the caller pins, and keep its caller repository and ref
restrictions. [GitHub documents this called-workflow
claim][github-oidc-reusable-workflows] separately from the standard caller
claims.

[github-oidc-reusable-workflows]:
  https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows

Always reference `cupboard-flake-publish.yml` by an immutable release tag in the
caller, `@vX.Y.Z`, not by a local path. The tenant's trust rule can then require
that pushes come from this exact file at that release, so a pull request cannot
smuggle in an edited copy of the publish job and gain the rule's access, and one
release pins the workflow code and the trust rule together.
`cupboard-publish.yml` follows its own convention: callers reference it at
`@main`, it fetches its action code from `main`, and its trust rules pin
`refs/heads/main`.

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
  --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main \
  --allow push --allow attest --allow root \
  --root github:acme/infra/main/
```

The trailing slash on the root makes it a prefix, so one grant covers every
per-system root beneath it.

## The run-root grant

A build-time push may bind a run root at negotiate: every path the push commits
is attached under that name and retained for the root's own time-to-live.
Attaching is its own operation, `root:attach`, granted by the `attach`
shorthand. Like `root`, it binds a root selector, so give the rule the exact
name or trailing-slash prefix the run roots will use:

```bash
cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cupboard.example.workers.dev/t/acme \
  --allow push --allow attest --allow root --allow attach \
  --root github:acme/infra/main/
```

A push that names both a target root and a run root asks for two grants on the
same cache, one per root selector. Rule selection picks exactly one trust rule
per exchange, so the same rule must permit both grants: splitting the
target-root and run-root allowances across two rules leaves the exchange with
whichever single rule was selected, and it cannot grant the other. The exchange
asks for everything or nothing, so a rule that cannot grant both refuses the
whole exchange, which is the safer failure: the push learns at token exchange,
never by silently publishing without its retention.

## The flake publish workflow's grants

The flake publish workflow depends on that prefix. Each of its jobs exchanges
its own OIDC token under the same trust rule: the plan job ensures a retention
root for each already-cached target, and the seed, fallback and target jobs push
and attest. Every root it writes, one per target and one per shared-output
group, sits beneath the `root-prefix` the caller passes, so a single prefix
grant covers them all. Trust it with the branch preset, pinning
`job_workflow_ref` to cupboard's reusable file:

```bash
# Trust main's flake publish. The preset grants github:acme/app/main/, a
# prefix covering every per-target and shared-output root the run writes.
cupboard oidc-trust add-github-branch https://cupboard.example.workers.dev/t/acme \
  --repo acme/app --branch main \
  --job-workflow-ref underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/vX.Y.Z
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
      cupboard-version: vX.Y.Z
```

The `job_workflow_ref` names the file in `underwhelmingperformance/cupboard`,
where the reusable workflow lives, not the caller's repository. The plan and
build jobs run inside cupboard's workflow, so that is the claim their token
carries; the caller is still pinned, by the repository ids and `ref` the preset
sets.

With `intermediate-retention: grace`, the seed and fallback jobs no longer write
a root at all, so the prefix grant above only needs to cover the target jobs'
named per-target roots; the trust rule itself needs no change, since an unused
`root` allowance is harmless. The plan job's confirmation calls need
`upload:confirm`. The `push` shorthand used by both presets includes that action
explicitly, so no separate `--allow` is needed for grace mode. A hand-written
grant containing only `upload:commit` cannot mint confirmation authority: commit
is confined to upload-specific state, while confirm can refresh any committed
path in the cache.

## Capture rules

Release builds usually go to a cache named after the tag, and no preset covers
that. `--capture` builds the rule instead: it reads a value out of a token claim
using a pattern with a named group, and that value fills the `{...}`
placeholders in `--cache-template` and `--root-template`. The pattern also acts
as a filter: a token whose claim does not match is refused. This rule sends a
build of tag `v1.2.3` to a cache called `v1.2.3`:

```bash
cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cupboard.example.workers.dev/t/acme \
  --claim repository_id=123456 \
  --claim repository_owner_id=7890 \
  --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main \
  --capture 'ref=^refs/tags/(?<tag>v[0-9][A-Za-z0-9.+-]*)$' \
  --cache-template '{tag}' \
  --root-template 'github:acme/infra/{tag}/' \
  --allow push --allow attest --allow root
```

The two numeric id claims pin the repository the same way the presets do.
`gh api repos/<owner>/<repo>` prints both: `.id` and `.owner.id`.
