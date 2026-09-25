# Caches

Every tenant starts with one cache, the **default cache**. Its URL is the tenant
URL:

```
https://cupboard.example.workers.dev/t/acme
```

You can add as many **named caches** as you like. Each one has its own URL:

```
https://cupboard.example.workers.dev/t/acme/cache/release
```

Nix treats each cache as a separate substituter. Each one has its own settings:
whether it's public or private, its priority, and how long it keeps store paths
(see [Retention](./retention.md)).

Most `cupboard cache` commands take the tenant URL followed by a cache name. In
the examples below, the cache is called `release`.

## Creating a cache

```sh
cupboard cache create https://cupboard.example.workers.dev/t/acme release \
  --access private
```

You must say whether the cache is public or private:

- `--access public` lets anyone read it.
- `--access private` means Nix needs a
  [read credential](../use/private-caches.md#read-credentials) to read it.

These options are optional:

- `--priority` sets the priority that the cache advertises to Nix. Nix tries
  caches with lower numbers first. The default is 40.
- `--root-ttl` sets how long store paths are kept by default, and `--grace` sets
  a grace period. See [Retention](./retention.md). If you leave these out, store
  paths are kept until you remove them.
- `--if-absent` makes the command succeed without changing anything if the cache
  already exists. This is useful in scripts.

A cache name can be up to 63 characters long. It can contain lower-case letters,
digits, `.`, `_` and `-`, and must start with a letter or a digit.

You don't have to create a named cache before pushing to it. The first push to a
cache URL that doesn't exist yet creates the cache, with default settings: the
same access as the default cache, priority 40, and store paths kept until you
remove them. Create the cache yourself first if you want different settings.

## Changing a cache's settings

To make the `release` cache public, or change its priority:

```sh
cupboard cache set-access https://cupboard.example.workers.dev/t/acme release \
  --access public
cupboard cache set-priority https://cupboard.example.workers.dev/t/acme release \
  --priority 30
```

To change the default cache instead, leave out the cache name:

```sh
cupboard cache set-access https://cupboard.example.workers.dev/t/acme \
  --access public
```

Changes take effect immediately. The cache keeps its URL and its contents.

When you make a cache private, Nix can read it with the tenant read credential.
If the operator has given the cache a read credential of its own, only that
credential works.

## Removing a cache

```sh
cupboard cache remove https://cupboard.example.workers.dev/t/acme release
```

If the cache still contains store paths, the command stops and tells you. To
remove the cache and everything in it, add `--force`. This also deletes its
retention roots, anything waiting to be uploaded, and its read credential.

The command asks you to confirm. In a script, add `--yes` to skip the question.

You can't remove the default cache.

If you later create a new cache with the same name, it starts empty and has
default settings. Nothing from the old cache comes back, and links to anything
that was in it stop working.

A named cache can also be set up to remove itself once it's empty. See
[Retiring empty caches](./retention.md#retiring-empty-caches).

## Seeing what's stored

| Command                               | What it shows                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `cupboard cache list <url>`           | All your caches and their settings.                                                |
| `cupboard cache inspect <url> [name]` | One cache in detail: access, priority, number of store paths, retention settings.  |
| `cupboard stats <url> [name]`         | How many store paths a cache has, pending uploads, and the size of what it stores. |
| `cupboard usage <url>`                | How much storage the tenant is using, and its quota if it has one.                 |
| `cupboard root list <url> [name]`     | The cache's retention roots. See [Retention](./retention.md).                      |

### How storage is counted

Storage is counted once per tenant. If the same file is used by several store
paths, or appears in several caches, you're only charged for it once. Sizes are
the compressed sizes.

If your tenant has a quota and reaches it, uploads start failing. To upload
again, free some space or ask the operator to raise the quota.

## Checking for problems

`cupboard check` makes sure that every store path in your tenant still has all
of its files:

```sh
cupboard check https://cupboard.example.workers.dev/t/acme
```

Add `--deep` to also download every file and check that its contents are
correct. This takes longer.

Any problems are shown as warnings. If there are any, the command exits with
status 1, so you can use it in CI.
