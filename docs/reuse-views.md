# Reuse views

What a named reuse view is, what its reads guarantee, and how the flake publish
workflow uses one to adopt earlier builds. The setup steps are in
[docs/github-actions.md](./github-actions.md).

A named reuse view is a set of caches a reader may substitute from, defined once
on the tenant with `cupboard reuse-view set`:

```bash
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme pull-requests \
  --prefix pr-
```

This view selects every cache whose name currently starts with `pr-`. A view
stores no narinfo and no membership list of its own. It is a live selector over
the caches it matches, so a cache created, renamed, or recreated under a
matching name is included without redefining the view.

An exact selector names one cache. Use the same `_default` alias as the other
cache-facing commands to select only the unnamed default cache:

```bash
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme default-only \
  --exact _default
```

## Read semantics

The view serves `nix-cache-info` and narinfo at `/t/<tenant>/reuse/<view>/`,
following the tenant's read mode: a public tenant exposes those routes publicly,
while a private tenant requires the existing Basic read credential.

Every reuse-view response, hit or miss, is served with
`cache-control: no-store`, so a shared HTTP cache never stores a stale or
incorrect response. A CDN in front of the view's routes therefore caches
nothing; take that into account before adding one.

A view spans every cache its selectors currently match, so any writer with push
access to one of those caches can influence what the view serves a reader.
Cupboard handles that risk the same way for every candidate. When a store-path
hash resolves to more than one semantically distinct result across the view's
caches, the lookup returns a miss instead of choosing between them, and the
affected target is built locally instead of substituted.

## Priorities

Nix tries substituters in the order of their advertised priorities, lowest
first. Cupboard's default cache advertises priority 40, a server default that
exists before any configuration; a view's priority must be numerically greater
than the destination's, so the destination is always tried first.
`actions/setup` enforces this: it fetches both `nix-cache-info` responses and
refuses to configure a view whose priority does not exceed the destination's.
Setup rejects a `nix-cache-info` response with no `Priority` line instead of
assuming a default.

## Use by the flake publish workflow

Passing `reuse-view` to `cupboard-flake-publish.yml` opts the run's
`actions/setup` and cohort jobs into that view. `actions/setup` adds the view as
a second Nix substituter, after the destination cache, so a cohort's build can
substitute shared work through the view instead of rebuilding it. Each cohort
job's own partition also probes the view for its targets' expected output paths:
a target the view alone already serves is published by reference, so the
destination adopts it without the bytes travelling through the runner. A hit in
the view does not retain anything on its own: only the destination retains
paths. The cohort's push still roots every target in the destination as usual.

## Adopting pull-request builds into a branch

A common shape adopts a pull request's build into `main`'s own publication. An
administrator defines the view once, covering the per-PR caches the
`add-github-pr` rule already routes builds to (see
[docs/trust-rules.md](./trust-rules.md)):

```bash
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme pull-requests \
  --prefix pr-
```

`main`'s post-merge workflow then opts into it:

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
      reuse-view: pull-requests
```

The tag pin selects that immutable published release. Set `cupboard-version`
only when you deliberately want to run a release other than the one the workflow
is pinned to.

If the merged commit's outputs already sit in the PR's cache from CI, the cohort
job publishes them by reference through the view, and the destination adopts and
roots them under `main`'s own roots without rebuilding. A target the PR never
built plans and builds exactly as it would without a view.
