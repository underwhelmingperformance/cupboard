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
holds no narinfo or membership of its own; it is a live selector over the caches
it names, so a cache created, renamed, or recreated under a matching name is
picked up without redefining the view.

An exact selector names one cache. Use the same `_default` alias as the other
cache-facing commands to select only the unnamed default cache:

```bash
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme default-only \
  --exact _default
```

## Read semantics

The view serves `nix-cache-info` and narinfo at `/t/<tenant>/reuse/<view>/`,
following the tenant's read mode: public tenants expose it publicly, private
tenants require the existing Basic read credential.

Every reuse-view response, hit or miss, is served with
`cache-control: no-store`, so a shared HTTP cache can never pin a stale or wrong
answer. Factor that in before fronting the view's routes with a CDN: they will
not be cached, by design.

A view spans every cache its selectors currently match, so any writer with push
access to one of those caches can influence what the view serves a reader.
Cupboard resolves the risk this creates the same way for every candidate: when a
store-path hash names more than one semantically distinct result across the
view's caches, the lookup answers as a miss rather than guessing, and the
affected target simply builds locally instead of substituting.

## Priorities

Nix tries substituters in the order of their advertised priorities, lowest
first. Cupboard's default cache advertises priority 40, a server default that
exists before any configuration; a view must sit numerically above the
destination it supplements so the destination is always tried first.
`actions/setup` enforces this: it fetches both `nix-cache-info` responses and
refuses to configure a view whose priority does not exceed the destination's. A
response without a `Priority` line is a configuration error rather than a
silently assumed default.

## Use by the flake publish workflow

Passing `reuse-view` to `cupboard-flake-publish.yml` opts the run's
`actions/setup` and cohort jobs into it. `actions/setup` adds the view as a
second Nix substituter, after the destination cache, so a cohort's build can
substitute shared work through the view instead of rebuilding it. Each cohort
job's own partition also probes the view for its targets' expected output paths:
a target the view alone already serves is published by reference, so the
destination adopts it without the bytes travelling through the runner. A hit
there retains nothing by itself, since the destination stays the only retention
boundary; the cohort's push still roots every target in the destination as
usual.

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
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@0123456789abcdef0123456789abcdef01234567 # vX.Y.Z
    permissions:
      attestations: write
      contents: read
      id-token: write
    with:
      url: https://cupboard.example.workers.dev/t/acme
      root-prefix: github:acme/app/main
      reuse-view: pull-requests
      cupboard-version: vX.Y.Z
```

If the merged commit's outputs already sit in the PR's cache from CI, the cohort
job publishes them by reference through the view, and the destination adopts and
roots them under `main`'s own roots without rebuilding. A target the PR never
built plans and builds exactly as it would without a view.
