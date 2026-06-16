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
