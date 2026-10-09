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

This workflow realises one flake installable on one runner, can publish selected
outputs, and can sign build provenance:

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

- The workflow requests a Cupboard read token through GitHub OIDC when the
  selected cache is private. Its trust rule must grant that cache's
  `cache:content-read` action as well as publication. The workflow has no static
  read-secret input.
- The workflow adds the runner's Nix system to the end of the root name. In this
  example, the root is `github:acme/app/main/x86_64-linux`. A macOS run of the
  same workflow sets a different root, so it doesn't replace the Linux one. The
  trust rule must allow the longer name, for example by allowing roots that
  start with `github:acme/app/main/`. If you leave out `root`, the workflow uses
  `github:<repository>/<ref>` without the system. Then each platform's run
  replaces the previous platform's root.
- Requested-output roots are permanent by default. Set `ttl` to make the root
  expire, or set `permanent: false` to use the cache's default root lifetime.
  Every published path, including intermediates, is also added to a run root
  beneath the selected root at `_cupboard-run/<run id>`. The run root expires
  after `run-root-ttl`, which defaults to `24h`. Set `run-root-permanent: true`
  and clear `run-root-ttl` to keep it permanently. The trust rule must grant
  `attach` for this root.
- The defaults are `build: missing`, `substituter: copy`, `publish: built` and
  `attest: true`. An available output can be used without building it again. The
  workflow selects substituted outputs and observed build intermediates for
  publication. It signs build provenance only for builds observed on the runner.
- Set `build: rebuild` when the run must execute every requested output again.
  This builds each requested output again in the selected Nix store, even if it
  is already available. Nix may still substitute dependencies. Set
  `attest: false` to publish without signing new evidence.
- With `substituter: leave`, an output stays upstream only if consumers can
  obtain matching NARs for the output and all its runtime references under the
  configured signature policy. Outputs built in this run remain selected. Set
  `publish: closure` to include every runtime reference of each selected
  published output. With `publish: none`, the workflow signs nothing.
- The CLI version matches the workflow version, in the same way as for the flake
  publish workflow. See
  [Selecting the cupboard version](./flake-publish.md#selecting-the-cupboard-version).
- The first push to a named cache that doesn't exist creates it, with the
  default cache's access and no default root TTL. Create the cache first with
  `cupboard cache create` if it needs other settings.
- Set `manage-pr-cache: true` with an explicit `cache` input to manage a cache
  for each pull request from the same repository. Setup creates a missing cache
  before publication. A `reopened` event restores write access. Every `closed`
  event, including a merge, closes the cache through its configured grace and
  skips publication. Include `closed` and `reopened` in the caller's event
  types. Use a shared concurrency group for every event of a pull request,
  including a merged close, and let `closed` runs wait for active publication
  before they close the cache. See [Concurrency ordering][concurrency-ordering].
  The trust rule needs `cache:create`, `cache:close` and `cache:reopen` for the
  selected cache. Setup acquires read authority before creating a missing cache.
  Publication and creation grants already imply scoped `cache:read`, which
  permits the absence response. Private content requires a `cache:content-read`
  grant without a root selector. Merged closes also need a separate closure-only
  rule. For an immutable workflow reference, use
  `oidc-trust add-github-pr-close` with the same `--cache-template` and the
  simple workflow's `--workflow-ref`. A caller that deliberately follows a
  branch can pass `--allow-branch-workflow` with its exact
  `@refs/heads/<branch>` workflow reference. This trusts future workflow edits.
  `github check --fix` can also repair the discovered lifecycle grants. See
  [Merged PR closure][merged-pr-closure]. Branch runs and `publish: none` do not
  change the cache lifecycle. See [Cache closure][cache-closure].
- The job needs a trust rule of its own. The rules that `cupboard github setup`
  adds accept only the flake publish workflow. See
  [Trust rules for these jobs](#trust-rules-for-these-jobs).

[concurrency-ordering]: ./quickstart.md#how-the-concurrency-setting-behaves
[merged-pr-closure]: ./trust-rules.md#pull-requests
[cache-closure]: ../admin/caches.md#closing-and-reopening-a-cache

The `attest` input remains a boolean. Set `attest: false` to publish without
signing new build provenance. A missing attestation does not cause an available
output to be rebuilt. Set `build: rebuild` when every requested output must be
built again; dependencies may still be substituted. See [Choosing publication
behaviour][publication-behaviour] for all four inputs and their interactions.

[publication-behaviour]: ./flake-publish.md#choosing-publication-behaviour

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
          cupboard-path: ${{ steps.setup.outputs.cupboard-path }}
          read-session-target: ${{ steps.setup.outputs.read-session-target }}
          read-session-view: ${{ steps.setup.outputs.read-session-view }}
          read-session-caches: ${{ steps.setup.outputs.read-session-caches }}
          audience: ${{ steps.setup.outputs.read-session-audience }}
          installables: .#package
          inline-paths: false
          publication-url: https://cupboard.example.workers.dev/t/acme
          build: rebuild
          substituter: copy
      - id: push
        uses: underwhelmingperformance/cupboard/actions/push@<commit> # vX.Y.Z
        with:
          cupboard-path: ${{ steps.setup.outputs.cupboard-path }}
          read-session-target: ${{ steps.setup.outputs.read-session-target }}
          read-session-view: ${{ steps.setup.outputs.read-session-view }}
          read-session-caches: ${{ steps.setup.outputs.read-session-caches }}
          audience: ${{ steps.setup.outputs.read-session-audience }}
          url: https://cupboard.example.workers.dev/t/acme
          paths-file: ${{ steps.build.outputs.publish-paths-file }}
          intermediate-paths-file:
            ${{ steps.build.outputs.intermediate-paths-file }}
          build-receipt-file: ${{ steps.build.outputs.receipt-file }}
          root:
            github:${{ github.repository }}/${{ github.ref_name }}/x86_64-linux
          permanent: true
          run-root:
            github:${{ github.repository }}/${{ github.ref_name
            }}/x86_64-linux/_cupboard-run/${{ github.run_id }}
          run-root-ttl: 24h
      - id: attest
        uses: underwhelmingperformance/cupboard/actions/attest@<commit> # vX.Y.Z
        with:
          cupboard-path: ${{ steps.setup.outputs.cupboard-path }}
          read-session-target: ${{ steps.setup.outputs.read-session-target }}
          read-session-view: ${{ steps.setup.outputs.read-session-view }}
          read-session-caches: ${{ steps.setup.outputs.read-session-caches }}
          audience: ${{ steps.setup.outputs.read-session-audience }}
          url: https://cupboard.example.workers.dev/t/acme
          inline-bundles: false
          receipt-file: ${{ steps.push.outputs.receipt-file }}
      - if: ${{ steps.attest.outputs.bundles-file != '' }}
        uses: underwhelmingperformance/cupboard/actions/attest-attach@<commit> # vX.Y.Z
        with:
          cupboard-path: ${{ steps.setup.outputs.cupboard-path }}
          read-session-target: ${{ steps.setup.outputs.read-session-target }}
          read-session-view: ${{ steps.setup.outputs.read-session-view }}
          read-session-caches: ${{ steps.setup.outputs.read-session-caches }}
          audience: ${{ steps.setup.outputs.read-session-audience }}
          url: https://cupboard.example.workers.dev/t/acme
          receipt-file: ${{ steps.push.outputs.receipt-file }}
          checksums-file: ${{ steps.attest.outputs.checksums-file }}
          bundles-file: ${{ steps.attest.outputs.bundles-file }}
```

The steps do the following:

1. `nix-quick-install-action` installs Nix. The cupboard actions need Nix, but
   they don't install it.
2. `setup` installs the cupboard CLI. Because `cache-url` is set, it also adds
   the cache to Nix's substituters for the rest of the job.
3. `build-paths` builds each requested output again in the selected Nix store,
   even if Nix could obtain it from a substituter or the runner's store.
   Dependencies may still be substituted. It writes a receipt describing how
   each output became available and lists the output paths selected for
   publication.
4. `push` publishes selected outputs and observed intermediates. It sets the
   requested-output root, adds every published path to the run root, and writes
   a receipt for the paths that the destination cache serves.
5. `attest` checks the receipt against the cache. It fails if a path that it
   will sign is missing or has different contents. It then signs build
   provenance for builds observed on the runner.
6. `attest-attach` attaches the signed bundles to the paths in the cache.

Keep the `if:` condition on the last step, and pass `bundles-file` to it.
`attest` lists build-provenance bundles in `bundle-path`. `bundles-file`
contains the manifest of all bundles. Set `inline-bundles: false` when the next
step uses the manifest. The default is `true`, which also returns complete
inline lists. `attest-attach` fails if it is given no bundles, so the condition
skips the step when `bundles-file` is empty. A cohort can publish a path without
building it; that path receives no new build provenance from this run.

The composite actions install pinned versions of Node.js and pnpm. They stay on
`PATH` for the rest of the job. The native `build-paths` action uses GitHub's
Node.js runtime and does not change the toolchain on `PATH`.

### Permissions and trust rules

Each action needs certain job permissions, and some need grants in the trust
rule that accepts the job. The table lists publication requirements. Private
OIDC reads additionally need `id-token: write` and content-read grants:

| Action          | Job permissions                                                                                      | Trust rule grants                                         |
| --------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `setup`         | `id-token: write` with `provision-cache`                                                             | `create`, with `provision-cache`                          |
| `build-paths`   | None                                                                                                 | None                                                      |
| `push`          | `id-token: write`                                                                                    | `push`, `root` for its root, and `attach` with `run-root` |
| `attest`        | `id-token: write`. `attestations: write` if `upload-to-github` is on, the default for a public cache | None                                                      |
| `attest-attach` | `id-token: write`                                                                                    | `attest`                                                  |

`attestations: write` lets `attest` upload bundles to the repository's
attestation store. The permission doesn't upload anything by itself.
`upload-to-github` decides whether `attest` uploads, as
[Signing profiles](./attestation.md#signing-profiles) describes.

`setup`, and `push` when it installs cupboard itself, check the release's
attestation with the job's token. A job's token can read the attestations of a
public repository, such as cupboard's, without `attestations: read`. If
`release-repository` is a private repository, such as a private fork of
cupboard, grant `attestations: read` and `contents: read` as well. The flake
publish workflow grants `attestations: read` to its plan and cache-removal jobs,
which verify the cupboard release that they install.

For private OIDC reads, pass the setup outputs to every later action that reads
the configured resources, as the example does. `read-session-target` selects the
primary cache or view, `read-session-view` adds the view, and
`read-session-caches` adds the other caches. Pass `read-session-audience` as
`audience` so read acquisition and publication use the same audience. Each step
obtains one read token for all required resources and renews that token while
its command runs. These reads require `id-token: write` and content-read grants
in the trust rules that match the job. The tenant refuses a job token whose
audience is not the tenant URL, so leave setup's `audience` input unset or set
it to the tenant URL.

A tenant read credential can also read a private view. A cache read credential
only reads its cache; use the destination credential inputs for that pair and
OIDC for the view.

### Trust rules for these jobs

`push` and `attest-attach` sign in with the job's GitHub OIDC token, so a trust
rule on the tenant has to accept the job. The rules that
[`cupboard github setup`](./quickstart.md#2-configure-the-tenant) adds pin the
token's `job_workflow_ref` claim to the flake publish workflow. GitHub sets
`job_workflow_ref` for a job that runs in a reusable workflow, to that reusable
workflow's file and ref. A job that calls `cupboard-publish.yml` presents that
workflow instead, and a job built from the actions doesn't run in a cupboard
workflow at all, so those rules don't accept either job, and the exchange is
refused with "No trust rule matches the subject token".

For a `cupboard-publish.yml` job on `main`, like the example above, add a branch
rule that pins cupboard's workflow:

```sh
cupboard oidc-trust add-github-branch https://cupboard.example.workers.dev/t/acme \
  --repo acme/app --branch main --read-cache \
  --job-workflow-ref 'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v*'
```

A job built from the actions runs in your own workflow file, not in a reusable
workflow. GitHub's token identifies that file in its `workflow_ref` claim, and
documents `job_workflow_ref` only for reusable workflows, so a rule for this job
mustn't depend on `job_workflow_ref`. A branch rule without `--job-workflow-ref`
accepts the job's runs on `main`:

```sh
cupboard oidc-trust add-github-branch https://cupboard.example.workers.dev/t/acme \
  --repo acme/app --branch main --read-cache
```

That rule accepts every workflow in the repository that runs on `main`. To
accept only the job's workflow file, write the rule by hand and pin
`workflow_ref`. If the job above is in `.github/workflows/publish.yml`, the
repository ID is `123456` and the owner ID is `654321`, this rule gives the same
grants as the branch preset:

```sh
cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cupboard.example.workers.dev/t/acme \
  --claim repository_id=123456 --claim repository_owner_id=654321 \
  --claim ref=refs/heads/main \
  --claim workflow_ref=acme/app/.github/workflows/publish.yml@refs/heads/main \
  --allow read --allow push --allow root --allow attach --allow attest \
  --root github:acme/app/main/
```

Each of these rules publishes to the default cache, with roots under
`github:acme/app/main/`. [Trust rules](./trust-rules.md) explains the other
presets and how to write a rule by hand.

[`cupboard github check`](./github-check.md) checks a `cupboard-publish.yml` job
against the tenant's rules. It lists a job built from the actions for manual
review, because it can't work out what such a job requests.

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
  `setup` writes it to a netrc file. Nix uses it for authorised caches that
  don't have their own credential and for private views in the tenant. Because
  netrc uses the hostname as its machine key, other tenants on that host need
  their own complete URL credentials or separate jobs.
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
  each URL. Each URL must use HTTPS, or HTTP to a loopback host. Pass the value
  from a secret. Nix still needs each cache's public key.

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

Set `inline-paths: false` when later steps use the path files. The action always
writes files and counts. By default, the action also writes inline path lists to
the step outputs.

If the build fails, the action tries again, up to five attempts in total, and
waits longer after each failure. A successful rebuild that reports no build
activity fails immediately, because another attempt cannot recover the missing
observation. If every attempt fails, the step fails. Set `allow-failure` to let
the job continue anyway.

The default `publish: built` includes selected requested outputs and successful
intermediates reported by the post-build hook. Derivation-backed builds also
include required dependency outputs already available from configured tenant
caches or reuse views. These outputs are published by reference, including when
the target is cached. Dependencies absent from tenant sources cause no
additional build or download. Arbitrary command wrappers use observed
intermediates because they declare no target derivation graph. Other substituted
intermediates are excluded. Pass `intermediate-paths-file` to `push` and specify
a run root to retain those intermediates. `publish-paths-file` contains only
selected requested outputs, so requested-output roots exclude intermediates. The
receipt includes targets, observed intermediates and reused tenant dependencies.
Pass `receipt-file` as `build-receipt-file` to `push` so the push uses the
captured reference metadata. With `allow-failure`, successful intermediates
remain available even if every requested target fails.

`publish: built` requires `cupboard-path` from `setup` to resolve the hook
relay. A self-hosted runner needs a trusted local daemon or a daemonless local
store, and its Nix configuration must permit the post-build hook. An existing
hook or an unsupported remote store causes the action to fail before building.
Choose `publish: outputs` or `publish: closure` when the store cannot support
complete observation. A configured remote builder can report outputs returned to
the coordinating store, but its internal dependencies are not observed.

The receipt records how the requested outputs became available. Set
`build: rebuild` to build every requested output again in the selected Nix
store, even if it is already available. Nix may still substitute dependencies.

The deprecated `require-provenance: true` input also selects `build: rebuild`
when `build` is omitted. An explicit `build: missing` conflicts with that input
and fails before building. Replace `require-provenance: true` with
`build: rebuild`.

With `substituter: leave`, `publication-url` is required and must specify the
destination tenant or cache URL. The build action keeps paths from that tenant
selected for publication, including public cache and reuse-view results. The
action rejects a missing URL before planning or building.

`substituter: leave` excludes an output from publication only when external
consumers can obtain matching NARs for the output and all its runtime references
under the configured signature policy. The action checks anonymous access to
each narinfo and its advertised NAR. Runner-only netrc or URL credentials do not
establish access for consumers. If anonymous access cannot be confirmed, the
action keeps the output selected for publication. `substituter: copy` includes
those outputs. Outputs built in this run remain selected, including builds
dispatched to a configured remote builder.

When a requested output has no recorded derivation, the action uses its
derivation from the dry-run plan when the plan reports a matching output path.
If the plan cannot identify that derivation, the action passes the original
installable to Nix for the rebuild.

The action writes the receipt and path files to a private directory for each
invocation under `$RUNNER_TEMP`. Nix GC roots protect completed outputs until
the action's post-job step removes those roots. Repeated `build-paths` steps use
separate directories and roots.

The receipt can support SLSA build provenance for outputs built on the runner in
this run when the Nix activity log records the build. If another installable
fails and the action retries, the receipt preserves earlier local build evidence
only when the output's NAR hash and derivation still match. Outputs reused from
the selected store or obtained from a substituter receive no new build claim.

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

To attach bundles that already exist, list the bundle files in `attestations`,
one per line. `push` ignores blank lines, and an empty input attaches nothing.
cupboard attaches a bundle only to a path whose NAR hash is one of the bundle's
subjects. See
[How a bundle refers to a store path](./attestation.md#how-a-bundle-refers-to-a-store-path).

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
