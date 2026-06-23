# GitHub Actions

cupboard publishes self-contained binaries on GitHub Releases and provides
composite actions for installing the binary and pushing build outputs from CI.
The release workflow probes the ESM Node SEA path first, but the pinned Node
24.16 preparation-blob path currently publishes CommonJS SEA binaries when the
ESM smoke test fails. The composite actions bootstrap Node 24 for their small
TypeScript helper and run it with Node's built-in type stripping, so there is no
checked-in generated JavaScript action bundle.

GitHub documents the latest release endpoint as the latest non-prerelease,
non-draft release, and the action uses that endpoint when
`cupboard-version: latest` is selected. GitHub artifact attestations are the
default provenance path for public releases.

[github-latest-release]:
  https://docs.github.com/en/rest/releases/releases#get-the-latest-release
[github-artifact-attestations]:
  https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations

## Version Selection

Both actions accept `cupboard-version`. The default is `latest`.

- `latest` resolves through GitHub's latest release endpoint.
- `1.2.3` is normalised to `v1.2.3` and resolved by tag.
- `v1.2.3` is used as-is and resolved by tag.

Release API calls use `github-token`, which defaults to the workflow
`github.token`. Public unauthenticated downloads work, but the token avoids
unnecessary rate-limit failures.

## `actions/setup`

`actions/setup` installs the cupboard binary and can export Nix binary cache
configuration for later steps.

```yaml
permissions:
  attestations: read
  contents: read

steps:
  - uses: actions/checkout@v6
  - uses: owner/repo/actions/setup@v1
    with:
      cache-url: https://cupboard.example.workers.dev/t/<slug>
      trusted-public-key: cupboard-1:...
```

The action outputs `cupboard-path`, `cupboard-version`, and, when Nix config is
generated, `nix-config-file`.

Generated Nix config is written under `$RUNNER_TEMP` and exported through
`NIX_CONFIG`. The action does not mutate `/etc/nix/nix.conf`. If
`nix-config-file` is supplied, the generated config is also appended to that
file.

If `trusted-public-key` is omitted, setup fetches `/pubkey` from the cache URL
and trusts that cache signing key for this run. This is trust-on-first-use only
for the cache signing key. The cupboard binary trust path is the release
checksum plus `gh attestation verify`, scoped to the release repository and
source tag.

For private reads, provide `read-user` and `read-password`. The action writes a
private netrc file under `$RUNNER_TEMP`, sets mode `0600`, appends
`netrc-file = ...` to the generated Nix config, and never echoes the password.

## `actions/push`

`actions/push` installs cupboard if needed, resolves the supplied paths with
`nix path-info`, and pushes them with GitHub OIDC authentication.

```yaml
permissions:
  attestations: read
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v6
  - run: nix build .#package
  - uses: owner/repo/actions/push@v1
    with:
      url: https://cupboard.example.workers.dev/t/<slug>
      paths: |
        ./result
```

The action outputs `cupboard-path` and `cupboard-version`.

`paths` is newline-delimited. Use block scalar YAML for paths so spaces and
other shell-sensitive characters are not reinterpreted. The helper validates and
resolves each entry through Nix; it does not use GNU-only path resolution such
as `readlink -f`, so macOS is first-class.

The default OIDC audience is the `url` input. The default retention root is
`github:${{ github.repository }}/${{ github.ref_name }}`. `wait` defaults to
`true` and `wait-timeout` defaults to `10m`.

Attestation bundle paths are also newline-delimited. They attach a bundle that
already exists; `actions/attest` below produces one with the right subjects:

```yaml
- uses: owner/repo/actions/push@v1
  with:
    url: https://cupboard.example.workers.dev/t/<slug>
    paths: |
      ./result
    attestations: |
      ./dist/result.intoto.jsonl
```

## `actions/attest`

`actions/push` attaches a bundle but does not create one. cupboard files a
bundle against a store path only when the bundle's in-toto subject digest equals
that path's NAR hash. An attestation built over a file's own digest, which is
what `actions/attest-build-provenance` records by default, therefore does not
match. `actions/attest` produces a matching bundle: it resolves each path with
`nix path-info`, records the NAR hashes as subjects, and signs a single SLSA
build-provenance attestation over all of them.

```yaml
permissions:
  attestations: write
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v6
  - run: nix build .#package
  - id: attest
    uses: owner/repo/actions/attest@v1
    with:
      paths: |
        ./result
```

`paths` is newline-delimited and accepts the same store paths, derivations, and
installables as `actions/push`. The action outputs `bundle-path`, the signed
bundle covering every resolved path, alongside `checksums-file` and
`subject-count`. `id-token: write` lets the action obtain its Sigstore signing
certificate, and `attestations: write` records the attestation on the
repository.

Because the bundle carries every path as a subject, a later `cupboard push`
files it against each matching path in the pushed closure.

## Build, attest, and push

The three actions compose into one job: install cupboard and export read
configuration, build the outputs, attest them, then push the outputs with the
bundle attached.

```yaml
permissions:
  attestations: write
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v6
  - uses: owner/repo/actions/setup@v1
    with:
      cache-url: https://cupboard.example.workers.dev/t/<slug>
  - run: nix build .#package
  - id: attest
    uses: owner/repo/actions/attest@v1
    with:
      paths: |
        ./result
  - uses: owner/repo/actions/push@v1
    with:
      url: https://cupboard.example.workers.dev/t/<slug>
      paths: |
        ./result
      attestations: ${{ steps.attest.outputs.bundle-path }}
```

`setup` adds the cache as a substituter for the build, `attest` signs the
provenance over the built paths' NAR hashes, and `push` uploads the paths and
files the bundle against them. Pushing needs an `oidc_trust` rule on the tenant
that accepts this repository's GitHub Actions token, added with
`cupboard oidc-trust`.

## Trust rules

A push from CI exchanges its GitHub Actions OIDC token for a cupboard token. The
exchange succeeds only when a trust rule on the tenant both recognises the token
and permits everything the push asks for. The exchange is all-or-nothing: if the
push wants to attach attestations or set a retention root and the rule does not
grant those, the whole exchange is refused, not narrowed.

A good rule pins identity on two axes. The repository is pinned by its immutable
numeric ids (`repository_id` and `repository_owner_id`), so a rename cannot
silently transfer trust and nobody reusing the freed-up name inherits it. The
trigger is pinned by the `ref` claim, which is the branch (or pull request) that
started the run, so only that branch's pushes are accepted. Optionally the
workflow file is pinned too, by `job_workflow_ref`, as a further restriction.

The `add-github-pr` and `add-github-branch` commands assemble these rules for
the common cases. `add-github-pr` trusts pull-request builds and routes each one
to its own short-lived cache (`pr-<number>`) and matching retention root
(`github:<owner>/<repo>/pr-<number>/`), both keyed on the pull-request number,
so one PR cannot reach another's paths. `add-github-branch` trusts pushes to one
branch and publishes to the tenant's default cache under the retention root the
push action writes by default, `github:<owner>/<repo>/<branch>/`; it pins the
branch through the `ref` claim, so a sibling branch sharing a reusable workflow
cannot match. Both look up the repository's ids for you, grant the push and the
retention root, and grant attestation by default; pass `--no-attest` to withhold
it, or `--root-template` to override the root.

```bash
# Per-PR rule: build the pull request, push to its own pr-<n> cache.
cupboard oidc-trust add-github-pr https://cupboard.example.workers.dev/t/acme \
  --repo acme/infra

# Branch rule: pushes to main, requiring the reusable publish workflow,
# publish to the default cache.
cupboard oidc-trust add-github-branch https://cupboard.example.workers.dev/t/acme \
  --repo acme/infra --branch main \
  --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main
```

`--job-workflow-ref` is optional on both presets and restricts the rule further
to the `job_workflow_ref` claim, the workflow file that minted the token,
written `owner/repo/path@ref`. Give it with an `@ref` to match exactly, or
without one to match that file at any ref; the latter is what a reusable
workflow needs, since its ref is the file's own location rather than the branch
being built, and the branch is already pinned by `ref`. It is named after the
claim on purpose: `job_workflow_ref` is a different claim from `workflow` (the
workflow's name) and `workflow_ref` (the calling workflow).

For an issuer or claim shape the presets do not cover, the general
`cupboard oidc-trust add` takes the issuer, audience, claims and grants
directly. `--job-workflow-ref` sets the `job_workflow_ref` claim without
spelling out `--claim`, and omitting `--cache` scopes the grant to the tenant's
default cache:

```bash
cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \
  --issuer https://token.actions.githubusercontent.com \
  --audience https://cupboard.example.workers.dev/t/acme \
  --job-workflow-ref acme/infra/.github/workflows/cupboard-publish.yml@refs/heads/main \
  --allow push --allow attest --allow root \
  --root github:acme/infra/main/
```

The trailing slash on the root makes it a prefix, so one grant covers every
per-system root beneath it.

## Binary Releases

The release workflow publishes these assets for each version tag:

- `cupboard-vX.Y.Z-linux-x64.tar.gz`
- `cupboard-vX.Y.Z-linux-arm64.tar.gz`
- `cupboard-vX.Y.Z-macos-x64.tar.gz`
- `cupboard-vX.Y.Z-macos-arm64.tar.gz`
- `checksums.txt`

Each binary build tries the ESM path first: esbuild emits an ESM bundle, the SEA
config sets `mainFormat: "module"`, postject injects the blob into a pinned Node
24 binary, and the result is smoke-tested with `cupboard --version`,
`cupboard push --help`, and `cupboard config`. With Node 24.16.0 today that
smoke test fails because the preparation-blob path cannot execute ESM, so the
script rebuilds the same asset as a CommonJS SEA. ESM SEA should become the
published format once the pinned Node line supports it in the release path.

Public releases require GitHub artifact attestations for release assets. Signed
checksums are the fallback only for environments where GitHub attestations are
unavailable.

Secondary distribution channels can come later:

- npm bin package for developer convenience.
- Homebrew tap for macOS/manual installs.
- Nix flake package for Nix users.

Docker or OCI actions are not the primary path because they do not solve host
Nix store or daemon access and do not help macOS runners.
