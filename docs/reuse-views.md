# Reuse views

This document defines named reuse views, their read guarantees, and their use in
the flake publish workflow. The setup steps are in
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
following the tenant's read mode. A public tenant exposes those routes publicly,
while a private tenant requires the existing Basic read credential. Private
views use separate routes that always require authentication; see [Private
views][private-views].

[private-views]: #private-views

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

`--private` defines a view in the private namespace:

```bash
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme pull-requests \
  --private --prefix pr-
```

Here `pull-requests` is the local name. Its stored name is
`private/pull-requests`, and its contract name is `_private-pull-requests`.
Clients read it at `/t/<tenant>/private-reuse/pull-requests/`.

A view is public or private according to its namespace, exactly as a cache is.
The selectors in a view's body are plain names local to that namespace. A
private view's selectors match private caches, while a public view's selectors
match public caches. No selector reaches across the two namespaces, and the same
definition selects different caches in each. A private view refuses the
`_default` exact selector because the tenant's default cache is public and the
private namespace has no default cache.

Every request under `/private-reuse/` authenticates with the tenant's read
credential, regardless of the method or whether the view exists. A view can
select several caches, so a credential for one private cache does not open a
view over that cache. A tenant without a read credential has no readable private
view. A private view's responses carry `cache-control: no-store` like every
other reuse-view response, misses included.

A narinfo served by a private view refers to the view's NAR route. That route
requires the tenant's read credential and serves a NAR only when one of the
tenant's private caches references its hash. This private-namespace rule is
wider than the per-cache rule described in [What a private cache
protects][private-cache-privacy], because a view's selectors can change after
the server returns a narinfo and before the reader requests the corresponding
NAR.

[private-cache-privacy]: ./nix.md#what-a-private-cache-protects

`actions/setup` constructs `/reuse/<view>/` from its `reuse-view` input, so the
input configures only public views. To use a private view, configure
`/private-reuse/<view>/` directly and put the tenant credential in the URL's
userinfo, as for a private cache.

`cupboard reuse-view remove --private` removes a private view.
`cupboard reuse-view list` reports public and private views in one list, each
under the name that addresses it.

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

If CI already published the merged commit's outputs to a matching pull-request
cache, the cohort job publishes them by reference. The destination then serves
them under `main`'s retention roots without rebuilding. Targets absent from the
pull-request caches follow normal planning and build.
