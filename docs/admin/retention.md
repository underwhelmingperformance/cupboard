# Retention

cupboard doesn't keep store paths forever by default. It keeps a store path only
while something keeps it, and deletes the rest. This page explains what can keep
a store path, how long it's kept for, and how to choose settings for your
caches.

## How retention works

Two things can keep a store path in a cache.

The first is a **retention root**. A root is a name, such as
`github:acme/app/main`, that points at one or more store paths in a cache. It
keeps those store paths, and everything that they depend on, until the root
expires or you point it at something else.

The second is the cache's **grace period**. This is a length of time, such as 24
hours, set on the cache. When a store path is published, or a root stops keeping
it, the grace period keeps it for that long even if no root refers to it. Caches
have no grace period unless you set one.

A garbage collection runs regularly and deletes every store path that neither of
these is keeping.

Here's an example. You push each build of your `main` branch to the root
`github:acme/app/main`, in a cache with a 24-hour grace period:

1. You push build A. The root now points at A, so A is kept.
2. You push build B. The root now points at B instead. Nothing points at A any
   more, so the root has released A.
3. The grace period keeps A for another 24 hours, in case something still needs
   it.
4. After that, the next garbage collection deletes A. B stays until you replace
   it too.

## Choosing settings

| You want to                                | Do this                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Keep a branch's latest build indefinitely  | Push to a root with the branch in its name, with `--permanent`. Each push replaces the previous build. |
| Keep every release                         | Push each release to its own permanent root.                                                           |
| Let short-lived builds expire              | Give the cache a default root TTL: `cupboard cache set-root-ttl <url> <cache> --root-ttl 14d`.         |
| Let CI jobs pass store paths to each other | Give the cache a grace period, or use a run root. The flake publish workflow uses a run root.          |
| Clean up a cache that you no longer need   | Remove it, or set it to [retire when it's empty](#retiring-empty-caches).                              |

Don't push with [`--no-retain`](#pins) to a cache that has no grace period.
`--no-retain` publishes the store paths without a root or pin, so nothing keeps
them, and the next garbage collection deletes them. A push without `--root` or
`--no-retain` still keeps its store paths with pins.

## Retention roots

A root belongs to one cache. A root's targets are the store paths that it points
at. A root keeps its targets and every store path that they depend on in the
same cache, so you only need to list the top-level store paths.

The easiest way to set a root is to push to it:

```sh
cupboard push https://cupboard.example.workers.dev/t/acme \
  --root github:acme/app/main ./result
```

### Naming roots

A root name can be from 1 to 256 characters long, and can't contain control
characters. By convention, the name says where the store paths came from, such
as `github:acme/app/main/x86_64-linux`.

Two caches can each have a root with the same name. They're separate roots and
don't affect each other.

### Replacing a root's targets

Setting a root replaces all of its targets. It doesn't add to them. Any store
path that was a target before, and isn't now, is released. If the cache has a
grace period, the grace period keeps the store path for a while. Otherwise
nothing keeps it.

A root can have at most 149 targets. If you need more, use several roots.

### Managing roots directly

`cupboard root` lets you work with roots without pushing. The cache comes from
the URL that you give, such as
`https://cupboard.example.workers.dev/t/acme/cache/release`. Paths must be store
paths, not symlinks.

| Command                              | What it does                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root set <url> <name> <path...>`    | Replaces the root's targets. Every store path must already be published to the cache.                                                                                   |
| `root ensure <url> <name> <path...>` | Sets the root only if the cache can serve every store path. Otherwise it reports which store paths the cache can't serve, and changes nothing. Either way, it succeeds. |
| `root list <url> [cache]`            | Lists the roots, with how many targets each has and when it expires.                                                                                                    |
| `root targets <url> <name>`          | Lists a root's targets, and marks any that are missing.                                                                                                                 |
| `root remove <url> <name>`           | Removes the root, which releases its targets. In a script, add `--yes` to skip the confirmation.                                                                        |

### Pins

If you push without `--root`, cupboard still keeps the store paths that you
pushed. It gives each one a root of its own, called a **pin**. A pin's name is
`pin:<store-path hash>`.

Pins work like any other root. They follow `--ttl`, `--permanent` and the
cache's settings, and they show up in `cupboard root list`, where they can pile
up over time.

Store paths that were only pushed because `--closure` included them don't get
pins of their own. The pins on the store paths that you listed keep them.

To publish without any root or pin, use `--no-retain`. Only the cache's grace
period then keeps the store paths. A push from CI that uses `--github-oidc` must
use either `--root` or `--no-retain`.

### Run roots

In CI, one job often builds something that a later job in the same workflow run
needs. A **run root** collects everything that a CI run publishes, so later jobs
in that run can download it from the cache.

A run root behaves differently from an ordinary root:

- An ordinary root is replaced every time you write it. A run root only grows.
  Each push adds every store path that it publishes or finds already published.
- A later push can make a run root last longer, but never shorter. Once a push
  makes it permanent, it stays permanent.
- A run root has no limit on its number of targets.

```sh
cupboard push https://cupboard.example.workers.dev/t/acme \
  --root github:acme/app/main/x86_64-linux \
  --run-root github:acme/app/main/_cupboard-run/1234 --run-root-ttl 24h \
  ./result
```

A CI token needs the `attach` grant to add to a run root. See
[Trust rules](../ci/trust-rules.md#what-a-rule-can-grant). The flake publish
workflow uses a run root automatically.

## How long a root lasts

Each root is either permanent or has a TTL (time to live). A root with a TTL
expires that long after it was last written. For example, a root with a 14-day
TTL that you push to today expires in 14 days. If you push to it again next
week, it expires 14 days after that. Writing a root with a shorter TTL than
before can also bring its expiry forward.

### Choosing a root's lifetime when you push

Add `--ttl` or `--permanent` when you write the root:

```sh
cupboard push https://cupboard.example.workers.dev/t/acme \
  --root github:acme/app/pr-42 --ttl 14d ./result
```

A duration is one whole number followed by one unit: `s`, `m`, `h`, `d` or `w`.
For example, write `36h`, not `1d12h`. It can be from one second to 3,650 days.

### Setting a default for the cache

If you don't pass `--ttl` or `--permanent`, the root gets its lifetime from the
cache's settings. cupboard checks these in order:

1. A root-prefix override on the cache whose prefix matches the start of the
   root's name. If several match, the longest wins.
2. The cache's default root TTL.
3. If neither is set, the root is permanent.

To make roots in the `release` cache expire 14 days after they were last
written:

```sh
cupboard cache set-root-ttl https://cupboard.example.workers.dev/t/acme release \
  --root-ttl 14d
```

To keep roots whose names start with `github:acme/app/v` permanently, as an
exception:

```sh
cupboard cache set-root-ttl https://cupboard.example.workers.dev/t/acme release \
  --root-prefix github:acme/app/v --permanent
```

To remove that exception:

```sh
cupboard cache clear-root-ttl https://cupboard.example.workers.dev/t/acme release \
  --root-prefix github:acme/app/v
```

To make roots permanent by default again:

```sh
cupboard cache clear-root-ttl https://cupboard.example.workers.dev/t/acme release
```

Making roots permanent by default also cancels
[retirement](#retiring-empty-caches), if the cache was set to retire.

Some things to know about these settings:

- Prefixes are compared as plain text. So `github:acme/app/v` matches
  `github:acme/app/v1.2.3/...`, but it also matches `github:acme/app/very/...`.
- A cache can have up to 4,096 prefix overrides.
- Changing a cache's settings doesn't affect existing roots straight away. A
  root picks up the new settings the next time it's written.

### When an expired root disappears

The next garbage collection removes an expired root. Until then, which can be up
to an hour or so, `cupboard root list` still shows it, marked as expired.

## Grace periods

A grace period keeps store paths for a set time, even when no root refers to
them. It's useful in two situations:

- A later CI job can pick up what an earlier job published, without the store
  paths being deleted in between.
- A store path that a root has released has time to be added to another root
  before it's deleted.

To give the `release` cache a 24-hour grace period:

```sh
cupboard cache set-grace https://cupboard.example.workers.dev/t/acme release \
  --grace 24h
```

A grace period can be `0s`.

When a cache has a grace period, each store path is kept until that much time
has passed since the most recent of these events:

- It was published to the cache, with or without a root.
- A push found it already published.
- `cupboard confirm` confirmed it.
- A root released it, because the root was replaced, removed or expired. For an
  expired root, the grace period starts from when the root expired.

A store path's grace deadline only ever moves later. The only way to remove the
path sooner is `cupboard delete`.

### Grace-managed caches

Garbage collection has a safety check. If nothing at all is being kept in a
cache, garbage collection doesn't delete anything, in case the retention
settings are wrong.

Some caches are exempt from this check. When a cache that has a grace period,
even `0s`, first publishes, confirms or releases a store path, cupboard marks
the cache as grace-managed. From then on, the safety check doesn't apply. When
the cache's last root expires and its last grace deadline passes, garbage
collection empties it.

The mark is permanent. `cupboard cache clear-grace` removes the grace period,
but not the mark. After that, store paths published without a root are deleted
at the next garbage collection. The only way to clear the mark is to remove the
cache.

`cupboard cache inspect` shows whether a cache is grace-managed.

## Garbage collection

A job runs every hour. It collects each active tenant at least once every six
hours, and also soon after the tenant's next root expiry or grace deadline.
Suspended tenants aren't collected.

For each cache, a garbage collection:

1. removes expired roots, which releases their targets
2. drops grace deadlines that have passed
3. marks every store path that a root or grace deadline keeps, following each
   store path's dependencies
4. deletes every store path that isn't marked, except ones that are still being
   uploaded

Each cache is collected on its own. A store path kept in one cache doesn't keep
the same store path in another cache.

A NAR's bytes are deleted from storage only once no store path in any cache, in
any tenant, refers to them. This happens at least 70 minutes after the last
reference goes, and usually within a few hours. Deleting a store path from one
cache never removes bytes that another cache still serves.

## Retiring empty caches

A named cache can remove itself once it's empty. This is useful for short-lived
caches, such as one per pull request:

```sh
cupboard cache set-retirement https://cupboard.example.workers.dev/t/acme \
  gh-123456-pr-42 --when-empty true
```

The cache must have a default root TTL. You can't set it to retire if its roots
are permanent by default.

The cache becomes eligible to retire one default root TTL after you set this. If
you set it again, the wait starts again. Once the cache is eligible, a
maintenance pass removes it when it has no store paths, roots, grace deadlines
or work in progress. The maintenance pass checks again every six hours.

## Legacy retention policies

Before each cache had its own retention settings, cupboard used tenant-wide
retention policies. Upgrading a deployment converts these automatically.
`cupboard policy` lists and removes any that are left. See the
[v0.0.34 upgrade notes](../operator/upgrade-notes.md#v0034). A new tenant never
has any.
