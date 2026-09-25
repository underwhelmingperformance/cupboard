# Writing your own publishing job

Most repositories should use the [flake publish workflow](./flake-publish.md).
If it doesn't fit your repository, you have two other options:

- `cupboard-publish.yml`, a simpler reusable workflow that builds one flake
  output on one runner and publishes it.
- A job of your own, built from the composite actions that both reusable
  workflows use.

[The actions reference](../reference/actions.md) lists every input and output of
the workflows and actions.

Always refer to the workflows and actions in `underwhelmingperformance/cupboard`
directly. Don't copy them into your own repository. They locate their own code,
and the cupboard releases that they install, relative to that repository. Both
workflows also refuse to run anywhere except github.com.

## The simpler workflow: `cupboard-publish.yml`

This workflow builds one flake installable on one runner, publishes it, and
signs its build provenance:

```yaml
jobs:
  publish:
    permissions:
      attestations: write
      contents: read
      id-token: write
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@vX.Y.Z
    with:
      url: https://cupboard.example.workers.dev/t/acme
      installable: .#packages.x86_64-linux.default
      root: github:acme/app/main
      trusted-public-key: cupboard-acme-1:...
```

Things to know before you use it:

- The cache must be public. The workflow doesn't accept read credentials.
- The workflow adds the runner's Nix system to the end of the root name. In this
  example, the root is `github:acme/app/main/x86_64-linux`. A macOS run of the
  same workflow sets a different root, so it doesn't replace the Linux one. The
  trust rule must allow the longer name, for example by allowing roots that
  start with `github:acme/app/main/`. If you leave out `root`, the workflow uses
  `github:<repository>/<ref>` without the system. Then each platform's run
  replaces the previous platform's root.
- Roots are permanent by default. Set `ttl` to make the root expire, or set
  `permanent: false` to use the cache's default root lifetime.
- By default, the job builds every output itself. Build provenance can only
  describe a build that the job saw. If an output was downloaded from a cache,
  or was already in the runner's store, the job rebuilds it with
  `nix build --rebuild` before signing. If the rebuild produces different
  contents, the job fails. Set `attest: false` to publish without build
  provenance.
- The CLI version matches the workflow version, in the same way as for the flake
  publish workflow. See
  [Selecting the cupboard version](./flake-publish.md#selecting-the-cupboard-version).

## Building a job from the actions

This job builds a flake output, publishes it, and signs its build provenance:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      attestations: write
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: nixbuild/nix-quick-install-action@9f63be77f412a248c9d9a65a4c82cf066cdf8f0c # v35
      - id: setup
        uses: underwhelmingperformance/cupboard/actions/setup@<commit> # vX.Y.Z
        with:
          cupboard-version: vX.Y.Z
          cache-url: https://cupboard.example.workers.dev/t/acme
          trusted-public-key: cupboard-acme-1:...
      - id: build
        uses: underwhelmingperformance/cupboard/actions/build-paths@<commit> # vX.Y.Z
        with:
          installables: .#package
          require-provenance: true
      - uses: underwhelmingperformance/cupboard/actions/push@<commit> # vX.Y.Z
        with:
          url: https://cupboard.example.workers.dev/t/acme
          cupboard-path: ${{ steps.setup.outputs.cupboard-path }}
          paths: ${{ steps.build.outputs.paths }}
          root:
            github:${{ github.repository }}/${{ github.ref_name }}/x86_64-linux
          permanent: true
      - id: attest
        uses: underwhelmingperformance/cupboard/actions/attest@<commit> # vX.Y.Z
        with:
          url: https://cupboard.example.workers.dev/t/acme
          receipt-file: ${{ steps.build.outputs.receipt-file }}
      - if: >-
          steps.attest.outputs.bundle-path != '' ||
          steps.attest.outputs.origin-bundle-path != ''
        uses: underwhelmingperformance/cupboard/actions/attest-attach@<commit> # vX.Y.Z
        with:
          url: https://cupboard.example.workers.dev/t/acme
          cupboard-path: ${{ steps.setup.outputs.cupboard-path }}
          receipt-file: ${{ steps.build.outputs.receipt-file }}
          checksums-file: ${{ steps.attest.outputs.checksums-file }}
          bundle: |
            ${{ steps.attest.outputs.bundle-path }}
            ${{ steps.attest.outputs.origin-bundle-path }}
```

The steps do the following:

1. `nix-quick-install-action` installs Nix. The cupboard actions need Nix, but
   they don't install it.
2. `setup` installs the cupboard CLI. Because `cache-url` is set, it also adds
   the cache to Nix's substituters for the rest of the job.
3. `build-paths` builds the installables. It writes a receipt, a file listing
   the outputs that this job built. `require-provenance` makes it rebuild any
   output that Nix downloaded instead of building. Without that, a rerun after a
   failed signing step would download everything from the cache, and there would
   be no build to attest.
4. `push` publishes the outputs and sets their retention root.
5. `attest` checks every path in the receipt against the cache. It fails if the
   cache is missing a path, or has different contents for it. It then signs
   build provenance for the paths that this job built.
6. `attest-attach` attaches the signed bundles to the paths in the cache.

Keep the `if:` condition on the last step. `attest` writes two kinds of bundle:
build provenance, in `bundle-path`, and build origin, in `origin-bundle-path`. A
job that built nothing produces no build provenance, but it can still produce
build-origin bundles. `attest-attach` fails if it is given no bundles at all, so
the condition runs it whenever either output is set.

Every action also installs a pinned version of Node.js and pnpm. They stay on
`PATH` for the rest of the job.

### Permissions and trust rules

Each action needs certain job permissions, and some need grants in the trust
rule that accepts the job:

| Action          | Job permissions                                                                                      | Trust rule grants                                         |
| --------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `setup`         | `id-token: write` with `provision-cache`                                                             | `create`, with `provision-cache`                          |
| `build-paths`   | None                                                                                                 | None                                                      |
| `push`          | `id-token: write`                                                                                    | `push`, `root` for its root, and `attach` with `run-root` |
| `attest`        | `id-token: write`. `attestations: write` if `upload-to-github` is on, the default for a public cache | None                                                      |
| `attest-attach` | `id-token: write`                                                                                    | `attest`                                                  |

`setup`, and `push` when it installs cupboard itself, check the release's
attestation with the job's token. A job's token can read the attestations of a
public repository, such as cupboard's, even with no permissions, so the job
doesn't need `attestations: read` for this.

`push` and `attest-attach` sign in with the job's GitHub OIDC token. See
[Trust rules](./trust-rules.md). For a private cache, `attest` and
`attest-attach` also need `read-user` and `read-password`.

### `setup`

`setup` writes its Nix settings to a file in `$RUNNER_TEMP`. It then sets
`NIX_CONFIG` so that later steps include that file. This replaces any
`NIX_CONFIG` value from earlier in the job. `setup` never edits
`/etc/nix/nix.conf`.

Some Nix processes don't inherit the step's environment, and so don't see
`NIX_CONFIG`. For those, pass your own Nix configuration file as
`nix-config-file`. `setup` adds a line to your file. When the settings file from
`setup` exists, the line includes that settings file.

If you don't set `trusted-public-key`, `setup` downloads the cache's current
public keys from `/pubkey` and trusts them for the rest of the job. It prints a
warning when it does this.

To choose named caches, list them in `cache`, one per line or separated by
commas. Leave `cache` empty to use the default cache. To use the default cache
as well as named caches, set `include-default-cache: true`.

#### Private caches

There are three ways to give `setup` credentials, depending on what you're
reading:

- To use the tenant read credential, pass it as `read-user` and `read-password`.
  `setup` writes it to a netrc file. Nix uses it for every cache on the same
  host that doesn't have its own credential.
- To use cache read credentials, pass a single cache's credential as
  `destination-read-user` and `destination-read-password`. For several caches,
  pass `cache-credentials`, a JSON array with one entry per cache:

  ```json
  [
    {
      "cache": { "kind": "named", "name": "release" },
      "credential": { "user": "cupboard", "password": "..." }
    }
  ]
  ```

  Each entry must refer to one of the selected caches, and each cache can appear
  only once. `setup` puts these credentials into the cache's substituter URL.

- To read from private caches that the job doesn't publish to, pass them in
  `private-substituters`, one URL per line, with the username and password in
  each URL. Pass the value from a secret. Nix still needs each cache's public
  key.

`setup` hides every password, and every URL that contains one, in the job log.
Pass `read-password` from a secret too, so that the runner hides it. This only
affects the log, so never write credentials into artefacts or job summaries.

#### Reuse views

`reuse-view` adds a [reuse view](./reuse-views.md) as an extra substituter,
after the caches that you're publishing to. Nix must try the view last, so
`setup` refuses a view whose priority number is not higher than every other
cache's.

### `build-paths`

List the installables in `installables`, one per line. If the list is long and
generated, write it to a file and pass `installables-file` instead. Action
inputs have a size limit, and the limit doesn't apply to a file.

If the build fails, the action tries again, up to five attempts in total, and
waits longer after each failure. If every attempt fails, the step fails. Set
`allow-failure` to let the job continue anyway.

The receipt only lists outputs that this job built itself. If an output was
built on a remote builder, or by an earlier failed attempt, the action rebuilds
it locally with `nix build --rebuild` before listing it. If the rebuild produces
different contents, the step fails. With `require-provenance`, outputs that were
downloaded or already in the store are rebuilt the same way, locally and one at
a time. An output with no derivation can't be rebuilt, so it fails the step.

The action writes the receipt and the list of paths to fixed locations in
`$RUNNER_TEMP`. A second `build-paths` step in the same job overwrites them.

A `build-paths` receipt only produces build provenance. Build-origin
attestations need the more detailed receipt that the flake publish workflow
writes.

### `push`

List the paths to publish in `paths`, one per line. Use a literal block scalar
(`|`) so that each path stays on its own line. Each entry must be a store path,
or a path that resolves to one, such as a `result` symlink. To publish a flake
output, build it first.

By default, the root is `github:<repository>/<ref name>`. To use a different
root, set `root`. You can also set `ttl` for an expiring root, or `permanent`
for one that never expires. If you set neither, the root uses the cache's
default lifetime. To publish without setting a root, set `no-retain: true`. The
cache's grace period then decides how long the paths are kept.
[Retention](../admin/retention.md) explains these options.

By default, `push` waits until the cache has verified the uploaded files. It
waits up to 10 minutes for the cache to accept the upload, and up to 10 minutes
more for verification. `wait-timeout` changes these limits. Keep the waiting
turned on if an `attest` step follows, because `attest` needs the paths to be
published.

The action's outputs report what it did: `uploaded-paths`, `reused-blobs`,
`skipped-paths` and `uploaded-bytes`. It also outputs the `cupboard-path` and
`cupboard-version` that it used.

## Selecting a cupboard version

`setup` and `push` install a cupboard release. `cupboard-version` chooses which:

| Value              | Installs                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latest` (default) | The newest release, including prereleases. With `include-prereleases: false`, GitHub's latest release, which is normally the newest full release. |
| `v1.2.3`           | That release.                                                                                                                                     |
| `1.2.3`            | The release tagged `1.2.3`, or `v1.2.3` if there is no `1.2.3` tag.                                                                               |

Pinning the action to a commit doesn't pin the version of the CLI that it
installs. Pass the matching `cupboard-version` as well, as the example does. The
actions can install releases from `v0.0.19` onwards.

Before installing a release, the action checks the downloaded archive against
the release's `checksums.txt`. It then verifies the release's GitHub artifact
attestation, which must meet three conditions:

- It was signed by the `release.yml` workflow in the release repository.
- It covers exactly that archive.
- It records the commit that the tag points to.

Set `expected-source-commit` to also require a particular commit. If any check
fails, the action doesn't install the release.

To use a CLI that an earlier step installed, pass that step's `cupboard-path`
output to later actions instead of a version. `attest-attach` requires this.
