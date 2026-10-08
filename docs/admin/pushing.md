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

| Summary label            | Meaning                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| Uploaded paths           | Store paths whose NARs were uploaded.                               |
| Available paths          | Store paths that the cache can serve after this push.               |
| Waiting for verification | Accepted store paths whose availability is not yet confirmed.       |
| Reused stored content    | Store paths published by reusing a NAR that the tenant already had. |
| Already available        | Store paths that were already in this cache.                        |

When `push` compressed at least one NAR, the summary also has these rows. The
`build-push` summary has them too.

| Summary label                      | Meaning                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| NAR bytes compressed               | The size of the uploaded NARs before compression.                                                                  |
| Compressed bytes                   | The size of the uploaded NARs after compression.                                                                   |
| Compression rate per upload worker | NAR bytes compressed, divided by the summed time that the uploads waited for their NARs to be read and compressed. |
| Peak memory                        | The CLI process's peak resident set size when the summary was written.                                             |

The waits of concurrent uploads are added together, so the compression rate is
the average rate of one upload worker, not of the whole run. The JSON result's
`compression` object has `narBytes`, `compressedBytes`, `frames`,
`compressionMs` (the summed wait) and `peakRssBytes`.

A NAR that compresses to one part or less is uploaded with one request. A larger
NAR is uploaded in parts of 8 MiB. The first part is compressed into memory
before it is sent. Before each later part, the CLI estimates how many compressed
bytes remain. While at least two parts of compressed bytes are expected to
remain, the CLI sends the part as it compresses it. Otherwise it compresses the
part into memory first. The summary has these rows when `push` uploaded at least
one NAR, and the `build-push` summary has them too. The last four rows appear
only when their totals are not zero.

| Summary label          | Meaning                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-request uploads | NARs that were uploaded with one request.                                                                                                                                        |
| Parts sent             | Parts of the NARs that were uploaded in parts.                                                                                                                                   |
| Buffered parts         | Parts that were compressed into memory before they were sent.                                                                                                                    |
| Streamed parts         | Parts that were sent while they were compressed.                                                                                                                                 |
| Requests sent again    | Requests that failed and were sent again.                                                                                                                                        |
| Parts recompressed     | Streamed parts that failed and were recompressed from the store so that they could be sent again.                                                                                |
| Bytes sent again       | Bytes sent beyond the size of the stored objects: the bytes that failed requests had already sent.                                                                               |
| Padding bytes          | Bytes of the zstd skippable frames that filled streamed parts whose compressed bytes ended early. Decoders skip these frames, and the cache stores and serves them with the NAR. |

The JSON result's `transfer` object has `singleRequestUploads`, `partsSent`,
`bufferedParts`, `streamedParts`, `retries`, `recompressions`, `resentBytes` and
`paddingBytes`.

### Publishing captured cache metadata

`--reference-manifest <path>` publishes existing tenant NARs from captured
narinfos. It reads neither the source cache nor a Nix store. The destination
still checks that the tenant stores each declared NAR before it commits the
reference. If a NAR was collected, publication fails. If the destination serves
a different NAR for the same store path, publication fails before it updates the
target root or pins. Refresh the manifest before retrying.

The JSON file contains `version: 1` and a `paths` array. Each entry contains:

- `storePath`: the complete Nix store path, which must match the narinfo.
- `kind`: `target` to retain the path under the selected root or a pin, or
  `intermediate` to publish it without adding a retention target.
- `source`: the cache or reuse-view URL from which the narinfo was read.
- `narinfo`: the complete narinfo text, including its line breaks.

The manifest can include paths from several sources. Every path must appear
once. `--reference-receipt-file` records each path's source URL and NAR hash as
republished metadata. The receipt records republished paths, not a build or
download.

### Compatibility with older callers

`push` still accepts `--already-held`, `--no-already-held`, `--claimable` and
`--no-claimable`, but ordinary help omits them. These options do not change
publication receipts or establish that this run built a path.

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

This replaces the root's complete target set. One push with `--root` accepts at
most 149 target paths, so split a larger set across several roots. Run roots
grow through additive updates and have no total target limit.

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

If a store path fails before the cache accepts it, `push` doesn't set any roots
or pins at all, and exits with an error. `push` sets the roots or pins before it
waits for verification, so a store path that later fails verification has
already been added to them. The cache then removes that store path from every
root, and `push` exits with an error.

## Waiting for the cache to verify uploads

After you upload a NAR, the cache checks it before it serves the store path. By
default, `push` waits until the cache has verified every uploaded NAR and can
serve every store path.

`push` asks the cache about a few store paths at a time, as each of its parallel
uploads (`--upload-concurrency`) finishes, and submits each store path as soon
as its NAR is uploaded. If the cache does not receive a store path's submission
within 15 minutes of `push` asking about it, the cache discards the upload.
While a NAR is being sent, `push` renews the upload every five minutes, up to
six hours after it first asked about the store path. An upload that takes less
than six hours therefore does not expire while it is being sent.

`push` waits for two things in turn. First it waits for the cache to accept each
store path. After every store path is accepted, it waits for verification. Each
wait has a limit of ten minutes. To change the limit, use `--wait-timeout`.

With `--debug`, `push` and `build-push` report how long each NAR took to upload.
They also report each NAR's size before and after compression, its number of
zstd frames, and how long the upload waited for the NAR to be read and
compressed. They report each part's number, size, duration and number of
attempts, and each request that failed and was sent again. With or without
`--debug`, they warn about each part that was recompressed from the store, with
the reason that its request failed, and about each part that was padded.

To return sooner, add `--no-wait`. `push` then returns once every store path is
accepted and its root or pin is set, without waiting for verification. If a
store path later fails verification, it's removed from its roots.

## Other options for `push`

- `--dry-run` shows what `push` would upload, reuse and retain, without changing
  anything. It still signs in and reads the local Nix store.
- `--attestation <bundle>` attaches a Sigstore bundle to each pushed store path
  that it covers. See [Attestations](../ci/attestation.md). With `--no-wait`,
  bundles aren't attached to store paths that are still being verified. You can
  attach them later with `cupboard attest attach`.
- `--store ssh-ng://...` reads the store paths from a remote Nix store instead
  of the local one. The remote store can only send a NAR from its start, so when
  a part of a large NAR has to be recompressed, every byte of the NAR before
  that part is sent over SSH again.
- `--upload-concurrency` sets how many uploads run in parallel. The default
  is 6.

The cache refuses a NAR that's larger than 4 GiB before compression. It checks
the size when `push` commits the upload, so the NAR is uploaded first.

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

- To run a build command, your user must be listed in the Nix daemon's
  `trusted-users`, or you must be using a single-user Nix installation.
  Otherwise `build-push` stops before the build starts, with exit status 77. For
  a list of installables in `--cohorts-file`, `build-push` doesn't stop. It runs
  the build and then publishes the outputs that were built, after the build
  finishes. It reports that outputs will be published after the build finishes.
  Add `--details` to see the Nix configuration that prevented publication during
  the build. See [Running several builds](#running-several-builds).
- No other `post-build-hook` can be configured.
- Your command must use the same Nix store as `build-push`. Don't pass `--store`
  to a Nix command that your command runs, and don't change `NIX_REMOTE`.
  `build-push` can't see or publish outputs in a different store.

### When publishing fails

If `build-push` can't publish some store paths, its summary lists them by
reason: the build, the upload, verification, removal from the local store, or
the retention root. Each reason shows up to ten store paths and the first error,
so you don't need `--debug` to see what failed.

### Exit statuses

`build-push` uses different exit statuses for a failed build and for failed
publishing, so a retry system can tell which one to retry:

| Status          | Meaning                                                                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0               | The build succeeded and every output was published. `build-push` confirms that the cache serves every output only when it waits for verification, which it does unless you pass `--no-wait`.                                                                                |
| the build's own | The build failed with this status. If a signal killed the build, the status is 128 plus the signal number.                                                                                                                                                                  |
| 1               | A rebuild or provenance requirement could not be met, or another failure has no specific status. Before the build, examples include an existing `post-build-hook`, a missing hook helper, a runtime socket path that is too long, or an API resource that returns HTTP 404. |
| 2               | A usage error, such as an unknown option or an upload request that exceeds the invocation budget.                                                                                                                                                                           |
| 69              | Something that the run needs isn't available, either before the build (for example, an `ssh-ng` store) or while publishing.                                                                                                                                                 |
| 74              | The build succeeded, but publishing or setting the root failed, and no more specific status applies.                                                                                                                                                                        |
| 75              | A temporary failure, either before the build (for example, in the GitHub OIDC token request or cupboard token exchange) or while publishing. Retrying may work.                                                                                                             |
| 77              | Signing in or a permission check failed, either before the build or while publishing. Before the build, this includes a missing retention grant or GitHub OIDC request permission, and a user that isn't in `trusted-users` when a build command runs.                      |
| 130             | Interrupted with Ctrl-C.                                                                                                                                                                                                                                                    |
| 143             | Terminated with `SIGTERM`.                                                                                                                                                                                                                                                  |

`build-push` never exits 1 for a publishing failure. If your build command
itself exits with 1, 2, 69, 74, 75 or 77, though, you can't tell its status
apart from `build-push`'s own statuses.
[Retrying](../reference/cli-scripting.md#retrying) explains which failures are
worth retrying.

### Running several builds

Instead of one command after `--`, you can give `--cohorts-file`. This runs
several builds in order. Each one is either a list of installables or a command.
See the [CLI reference](../reference/cli.md#cupboard-build-push) for the file's
format.

With `--keep-going-cohorts`, later cohorts still run after a failure. The first
failure without validated target-build evidence determines the exit status. If
every failure has that evidence, the first target build failure determines the
status. The combined receipt records command failures even when a failed cohort
could not write its own receipt, so a later successful cohort cannot hide an
authentication or publication failure.

## Checking that store paths are published

`cupboard confirm` checks that store paths are already in a cache, without
uploading anything:

```sh
cupboard confirm https://cupboard.example.workers.dev/t/acme \
  /nix/store/<hash>-app /nix/store/<hash>-runtime
```

For a large set, pass `--paths-file paths.txt` to read store paths one per line.
Blank lines are ignored. File entries are additional store paths, so specify a
named cache in the URL or as a positional argument. Every file entry must be a
store path. The CLI validates the file before requesting credentials. An invalid
store path in an argument or file exits with usage status 2. For a file entry,
the error identifies the file and line number.

Each result reports whether the path is available, followed by its retention
grace deadline when the cache reports one. Add `--details` to show complete
store paths. Confirmation also refreshes each store path's grace period, as a
new push would. It doesn't add the store paths to a root. It fails if any store
path is missing, or is still being verified.

## Deleting a store path

`cupboard delete` removes one store path from a cache straight away, even if a
root is keeping it:

```sh
cupboard delete https://cupboard.example.workers.dev/t/acme /nix/store/<hash>-app
```

Give it the store path itself, not a symlink to it. The command asks you to
confirm. In a script, add `--yes` to skip the question.

The result distinguishes removal from the cache from storage cleanup. Removal
stops new downloads from this cache. The underlying data may still be needed by
other paths or caches. A scheduled cleanup is not confirmation that the bytes
have been deleted; an unknown cleanup status does not prove that another path
retains the data.

Deleting a store path can leave gaps. Any root that kept it still lists it, as a
missing target. Any store path that depends on it loses part of its closure. So
use `delete` to withdraw a bad store path, not to tidy up. To let old store
paths go, change how they're retained instead. See [Retention](./retention.md).

For scripting the CLI in general, including output modes and exit statuses, see
[Scripting the CLI](../reference/cli-scripting.md).
