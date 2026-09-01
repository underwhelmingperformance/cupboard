# Reuse views

This document defines named reuse views, their read guarantees, and their use in
the flake publish workflow. The setup steps are in
[docs/github-actions.md](./github-actions.md).

A named reuse view is a set of caches a reader may substitute from, defined once
on the tenant with `cupboard reuse-view set`:

```bash
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme pull-requests \
  --select prefix:pr-
```

This view selects every cache whose name currently starts with `pr-`. A view
stores no narinfo and no membership list of its own. It is a live selector over
the caches it matches, so a cache created, renamed, or recreated under a
matching name is included without redefining the view.

An exact selector names one cache. Use `default` for the tenant's default cache:

```bash
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme default-only \
  --select default
```

Use `all-named` to select every named cache, or `all` to include the default
cache as well. A view selects only caches with the same access as the view.

## Read semantics

The view serves `nix-cache-info` and narinfo at `/t/<tenant>/reuse/<view>/`. Its
`access` property determines whether those routes are public or require a Basic
read credential.

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

## Private views

Set the view's access to `private`:

```bash
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme pull-requests \
  --access private --select prefix:pr-
```

Public and private views use the same name and URL. A private view selects
private caches. It can include the default cache when that cache is private:

```bash
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme pull-requests \
  --access private --select prefix:pr- --select default
```

An unknown view returns 404. Once the route resolves a private view, it
authenticates every content request with the tenant-wide fallback read
credential. A view can select several caches, so a credential for one private
cache does not open a view over that cache. A tenant without a fallback
credential has no readable private view. Its responses carry
`cache-control: no-store` like every other reuse-view response, misses included.

A narinfo served by a private view refers to the view's NAR route. That route
requires the tenant-wide fallback credential and serves a NAR only when a
private cache selected by the current view definition references its hash. The
server rechecks the view revision after reading shared state, so a concurrent
selector change produces a miss.

`actions/setup` constructs `/reuse/<view>/` from its `reuse-view` input. Put the
tenant-wide fallback credential in the URL's userinfo when the selected view is
private.

`cupboard reuse-view remove` removes a view. `cupboard reuse-view list` reports
each view's access property.

## Priorities

Nix tries substituters in the order of their advertised priorities, lowest
first. A cache starts at priority 40 unless its administrator chooses another
value. A view's priority must be numerically greater than the destination's, so
the destination is always tried first. `actions/setup` enforces this: it fetches
both `nix-cache-info` responses and refuses to configure a view whose priority
does not exceed the destination's. Setup rejects a `nix-cache-info` response
with no `Priority` line instead of assuming a default.

## Use by the flake publish workflow

Passing `reuse-view` to `cupboard-flake-publish.yml` configures both
`actions/setup` and the cohort jobs to use that view. `actions/setup` adds it as
a second Nix substituter, after the destination cache. Each cohort also probes
the view for the expected output paths. If only the view serves a target, the
workflow publishes it by reference. The destination then reuses its existing
bytes and retains the path under the target root. A view hit does not retain the
path by itself.

## Adopting pull-request builds into a branch

A post-merge `main` workflow can reuse outputs that CI published for the pull
request. An administrator defines the view once so it selects the per-PR caches
used by the `add-github-pr` rule (see [docs/trust-rules.md](./trust-rules.md)):

```bash
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme pull-requests \
  --select prefix:pr-
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

If CI already published the merged commit's outputs to a matching pull-request
cache, the cohort job publishes them by reference. The destination then serves
them under `main`'s retention roots without rebuilding. Targets absent from the
pull-request caches follow normal planning and build.
