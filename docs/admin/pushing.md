# Pushing

This page explains how to publish store paths to a cache from your own machine,
with `cupboard push` and `cupboard build-push`. To publish from GitHub Actions
instead, see the [CI quickstart](../ci/quickstart.md).

## Pushing store paths

Build something with Nix, then push the result to your tenant's default cache:

```sh
cupboard push https://cupboard.example.workers.dev/t/acme ./result
```

You can give `push` store paths, such as `/nix/store/<hash>-app`, or any file or
symlink inside a store path, such as `./result`. It publishes exactly the store
paths that you give it.

Store paths usually depend on other store paths. To publish those as well, add
`--closure`:

```sh
cupboard push https://cupboard.example.workers.dev/t/acme --closure ./result
```

`push` doesn't accept flake references such as `.#app`. Build them first, then
push the result.

### Pushing to a named cache

To push to a named cache, use the cache URL:

```sh
cupboard push https://cupboard.example.workers.dev/t/acme/cache/release ./result
```

If the cache doesn't exist yet, this creates it with default settings. See
[Creating a cache](./caches.md#creating-a-cache) if you want different settings.

You can also give the tenant URL followed by the cache name:

```sh
cupboard push https://cupboard.example.workers.dev/t/acme release ./result
```

This shorter form only works for a cache that already exists. `push` decides
what the argument after the tenant URL is in this order:

1. If a file or directory called `release` exists in the current directory,
   `push` treats `release` as a path to push.
2. Otherwise, if the tenant has a cache called `release`, `push` treats
   `release` as the cache name.
3. Otherwise, `push` treats `release` as a path.

### What the summary means

For each store path, `push` does one of three things:

- If the cache already has the store path, `push` skips it.
- If the tenant already stores the same NAR (the store path's contents)
  somewhere else, such as in another cache, `push` reuses that NAR and doesn't
  upload it again.
- Otherwise, `push` compresses the NAR and uploads it.

When it finishes, `push` prints a summary that counts each case:

| Summary label  | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| Uploaded       | Store paths whose NARs were uploaded.                               |
| Already cached | Store paths published by reusing a NAR that the tenant already had. |
| Skipped        | Store paths that were already in this cache.                        |

## Choosing how long store paths are kept

cupboard only keeps a store path while something keeps it, usually a retention
root. A retention root is a name that points at a set of store paths and keeps
them. [Retention](./retention.md) explains this in full. When you push, you
choose which root, if any, keeps the store paths.

To keep the store paths under a root with your branch in its name, use `--root`:

```sh
cupboard push https://cupboard.example.workers.dev/t/acme \
  --root github:acme/app/main ./result
```

This replaces whatever that root kept before. A root can keep at most 149 store
paths, so if you're pushing more than that, split them across several roots.

If you don't pass `--root`, `push` gives each store path a root of its own,
called a pin.

By default, the root or pins last as long as the cache's settings say. To choose
for yourself, add `--ttl` with a duration, or `--permanent`:

```sh
cupboard push https://cupboard.example.workers.dev/t/acme \
  --root github:acme/app/pr-42 --ttl 14d ./result
```

To publish without any root or pins, use `--no-retain`. The store paths are then
kept only for the cache's grace period. This is a length of time, set on the
cache, for which cupboard keeps store paths that no root refers to. If the cache
has no grace period, `push` warns you that the next garbage collection may
delete the store paths.

If any store path fails to publish, `push` doesn't set any roots or pins at all,
and exits with an error.

## Waiting for the cache to verify uploads

After you upload a NAR, the cache checks it before it serves the store path. By
default, `push` waits until the cache has verified every uploaded NAR and can
serve every store path.

`push` waits for two things in turn. First it waits for the server to accept the
push, then it waits for verification. Each wait has a limit of ten minutes. To
change the limit, use `--wait-timeout`.

To return sooner, add `--no-wait`. `push` then returns once every store path is
reserved and its root or pin is set, without waiting for verification. If a
store path later fails verification, it's removed from its roots.

## Other options for `push`

- `--dry-run` shows what `push` would upload, reuse and retain, without changing
  anything. It still signs in and reads the local Nix store.
- `--attestation <bundle>` attaches a Sigstore bundle to each pushed store path
  that it covers. See [Attestations](../ci/attestation.md). With `--no-wait`,
  bundles aren't attached to store paths that are still being verified. You can
  attach them later with `cupboard attest attach`.
- `--store ssh-ng://...` reads the store paths from a remote Nix store instead
  of the local one.
- `--upload-concurrency` sets how many uploads run in parallel. The default
  is 6.

`push` refuses a NAR that's larger than 4 GiB before compression.

## Publishing while a build runs

`cupboard build-push` runs a build command and publishes each output as soon as
Nix finishes building it. This is faster than waiting for the whole build to
finish and pushing afterwards.

Put the build command after `--`:

```sh
cupboard build-push https://cupboard.example.workers.dev/t/acme \
  --root github:acme/app/main -- nix build --no-link .#app
```

When the build succeeds, `build-push` sets the root once every output is
available. If the build fails, it still publishes whatever was built, but it
leaves the root as it was.

To write a record of what was built, add `--receipt-file`.
[Attestation](../ci/attestation.md) signs this receipt.

### What `build-push` needs

`build-push` works by setting Nix's `post-build-hook` setting while your command
runs. Because of this:

- Your user must be listed in the Nix daemon's `trusted-users`, or you must be
  using a single-user Nix installation. Otherwise `build-push` stops before the
  build starts, with exit status 77.
- No other `post-build-hook` can be configured.
- Your command must use the same Nix store as `build-push`. Don't pass `--store`
  to a Nix command that your command runs, and don't change `NIX_REMOTE`.
  `build-push` can't see or publish outputs in a different store.

### Exit statuses

`build-push` uses different exit statuses for a failed build and for failed
publishing, so a retry system can tell which one to retry:

| Status          | Meaning                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| 0               | The build succeeded and every output was published.                                                         |
| the build's own | The build failed with this status. If a signal killed the build, the status is 128 plus the signal number.  |
| 1 or 2          | `build-push` refused to start, for example because of a bad option or a conflicting hook.                   |
| 69              | Something that publishing needs isn't available.                                                            |
| 74              | The build succeeded, but some store paths failed to publish.                                                |
| 75              | Publishing stopped because of a temporary failure, such as the server being unreachable. Retrying may work. |
| 77              | Signing in or permission checks failed, either before or after the build.                                   |

If your build command itself exits with 1, 2, 69, 74, 75 or 77, you can't tell
its status apart from `build-push`'s own statuses.

### Running several builds

Instead of one command after `--`, you can give `--cohorts-file`. This runs
several builds in order. Each one is either a list of installables or a command.
See the [CLI reference](../reference/cli.md#cupboard-build-push) for the file's
format.

## Checking that store paths are published

`cupboard confirm` checks that store paths are already in a cache, without
uploading anything:

```sh
cupboard confirm https://cupboard.example.workers.dev/t/acme \
  /nix/store/<hash>-app /nix/store/<hash>-runtime
```

It also refreshes each store path's grace period, as a new push would. It
doesn't add the store paths to a root. It fails if any store path is missing, or
is still being verified.

## Deleting a store path

`cupboard delete` removes one store path from a cache straight away, even if a
root is keeping it:

```sh
cupboard delete https://cupboard.example.workers.dev/t/acme /nix/store/<hash>-app
```

Give it the store path itself, not a symlink to it. The command asks you to
confirm. In a script, add `--yes` to skip the question.

Deleting a store path can leave gaps. Any root that kept it still lists it, as a
missing target. Any store path that depends on it loses part of its closure. So
use `delete` to withdraw a bad store path, not to tidy up. To let old store
paths go, change how they're retained instead. See [Retention](./retention.md).

For scripting the CLI in general, including output modes and exit statuses, see
[Scripting the CLI](../reference/cli-scripting.md).
