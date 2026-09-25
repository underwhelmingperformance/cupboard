# Reuse views

When you merge a pull request, the run on `main` often builds exactly what the
pull request's run already built. The pull request published those store paths
to its own cache, such as `gh-123456-pr-7`, but `main` publishes to the default
cache. Without help, `main` would build everything again.

A **reuse view** solves this. It's a read-only cache URL that combines several
of your tenant's caches. For example, a view can combine every pull-request
cache of one repository. Nix can read from the view like any other substituter,
and finds store paths in any of the caches that it combines.

The flake publish workflow uses a view on `main` in two ways:

- Nix reads through the view, so `main` doesn't rebuild what a pull request
  already built.
- For each target that the view already has, the workflow publishes the target
  to the default cache by reference. cupboard already stores the bytes, so
  nothing is uploaded again.

`cupboard github setup`, in [the quickstart](./quickstart.md), creates a view
for each repository. It's called `pull-requests-<repository-id>`, and it
combines that repository's pull-request caches. The view is public, unless you
pass read credentials to `github setup`. This page explains how views work, and
how to define them yourself.

## Defining a view

This command defines a view called `pull-requests-123456`:

```sh
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme \
  pull-requests-123456 --select prefix:gh-123456-pr-
```

The view includes every cache whose name starts with `gh-123456-pr-`. Those are
the pull-request caches of the repository whose ID is 123456.

A view doesn't store any paths of its own. cupboard works out which caches the
view includes each time the view is read. A pull-request cache created later is
included automatically, without changing the view.

`--select` says which caches the view includes. You can repeat it, and give
between 1 and 32 different selectors:

| Selector          | Includes                                     |
| ----------------- | -------------------------------------------- |
| `prefix:<prefix>` | Every named cache whose name starts with it. |
| `cache:<name>`    | One named cache.                             |
| `default`         | The tenant's default cache.                  |
| `all-named`       | Every named cache.                           |
| `all`             | Every cache, including the default cache.    |

View names and prefixes follow the same rules as cache names. They can be up to
63 characters long, can contain lower-case letters, digits, `.`, `_` and `-`,
and must start with a letter or a digit.

### Changing and removing views

To change a view, run `reuse-view set` again with the whole new definition. The
new definition replaces everything about the view, including its access and
priority. If you leave out `--access` or `--priority`, they go back to public
and 50.

To see your views:

```sh
cupboard reuse-view list https://cupboard.example.workers.dev/t/acme
```

To delete one:

```sh
cupboard reuse-view remove https://cupboard.example.workers.dev/t/acme \
  pull-requests-123456
```

## Reading a view

A view's URL is the tenant URL followed by `/reuse/<view>`:

```
https://cupboard.example.workers.dev/t/acme/reuse/pull-requests-123456
```

It serves `nix-cache-info`, narinfos and NARs, like a cache. It doesn't serve
`/pubkey`. The narinfos from a view have the tenant's signatures, so Nix checks
them with the tenant's key as usual.

### When caches disagree about a path

Two caches in a view can have the same store path with different contents. If
they disagree on the NAR hash, NAR size, references, deriver or content address,
the view reports that it doesn't have the path. Nix then builds the path itself.

cupboard does this because anyone who can push to one of the caches can offer
paths to the view's readers. Choosing one version would let one writer win over
the others.

Different signatures aren't a disagreement. The view serves all of them.

### When a view's definition changes

A view only serves a NAR if one of the caches that the view currently includes
refers to that NAR. If you change the view's definition while Nix is reading a
path from it, the view reports that it doesn't have the path.

### Caching

Every response from a view has the header `cache-control: no-store`, whether the
path was found or not. What a view serves depends on the current contents of
several caches, so it mustn't be cached. A CDN in front of a view caches
nothing.

## Priority

Nix asks substituters in order of the priority that each one advertises, lowest
number first. You want Nix to ask the destination cache before the view, so the
view's priority must be a higher number than the destination's.

| Created by                | Default priority                |
| ------------------------- | ------------------------------- |
| `cupboard cache create`   | 40                              |
| `cupboard reuse-view set` | 50                              |
| `cupboard github setup`   | The destination's priority + 10 |

To change a view's priority, run `reuse-view set` again with the view's full
definition and the new `--priority`. To change a cache's priority, use
`cupboard cache set-priority`.

`actions/setup`, `cupboard github setup` and `cupboard github check` all refuse
a view whose priority isn't greater than the destination's. If you raise a
cache's priority number, raise the priority numbers of its views too.

## Private views

A view is public or private, like a cache. It only includes caches that have the
same access as itself. To define a private view:

```sh
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme \
  pull-requests-123456 --access private --select prefix:gh-123456-pr-
```

A private view only accepts the tenant read credential. A cache read credential
doesn't work, even for a view over that one cache, because a view can serve
paths from any cache that it includes. If your tenant has no tenant read
credential, none of its private views can be read.

In CI, pass the tenant read credential to the flake publish workflow as the
`fallback_read_*` secrets. See [Private caches in CI](./private-caches.md).

## How the flake publish workflow uses a view

When a run has a view, the workflow adds it to Nix's substituters after the
destination cache. It then asks the view for each target.

If the destination doesn't have a target but the view does, the workflow
publishes the target to the destination
[by reference](./how-it-works.md#the-four-groups-in-the-log), without uploading
it again. The target is kept under its root in the destination, like any other
published target.

With the `pull-request-and-branch` preset, only branch runs use a view.

A view doesn't keep anything. Only the destination's root keeps a path. When a
pull request is closed without being merged, its cache is removed. Otherwise,
the view keeps finding the pull request's outputs until garbage collection
removes paths that their roots no longer keep.

### Sharing builds between repositories

The view that `github setup` creates for a repository only includes that
repository's pull-request caches. To let `main` in one repository reuse builds
from another repository's pull requests, define a view that includes both. Then
pass its name as the calling workflow's `reuse-view` input:

```sh
cupboard reuse-view set https://cupboard.example.workers.dev/t/acme app-and-lib \
  --select prefix:gh-123456-pr- --select prefix:gh-654321-pr-
```

Both repositories' pull-request caches must have the same access as the view.

Only do this if you trust both repositories' pull requests equally. Either
repository's pull requests can then supply paths to the other's `main`.
