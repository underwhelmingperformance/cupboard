# Binary releases

How cupboard's release workflow builds and publishes the binaries that the
GitHub actions install. Nothing here is needed to use the actions; see
[docs/github-actions.md](./github-actions.md) for that.

## Release ordering

The upload protocol negotiates optional response fields explicitly. A new CLI
offers the `upload-grace-facts` capability in a request header, which an old
server ignores, and falls back to the legacy report for an ordinary retained
push when the server does not acknowledge it. A new server returns the legacy
response shapes unless the client offered that capability, so old CLIs keep
working unchanged.

Features whose safety depends on an acknowledged capability still require a new
enough server. In particular, `cupboard push --no-retain` performs a
side-effect-free capability preflight and refuses to publish if the server does
not acknowledge grace facts. Deploying the server first makes that feature
available immediately, but is not required to keep ordinary retained pushes
working during a rolling release.

The release itself scopes these stable platform asset names to one version:

- `cupboard-linux-x64.tar.gz`
- `cupboard-linux-arm64.tar.gz`
- `cupboard-macos-x64.tar.gz`
- `cupboard-macos-arm64.tar.gz`
- `checksums.txt`

Installers prefer these stable names, so a valid release tag never has to be a
valid filename. They retain lookup support for the older
`cupboard-vX.Y.Z-<platform>-<arch>.tar.gz` assets.

Each binary build tries the ESM path first: esbuild emits an ESM bundle, the SEA
config sets `mainFormat: "module"`, postject injects the blob into a pinned Node
24 binary, and the result is smoke-tested with `cupboard --version`,
`cupboard push --help`, and `cupboard config`. On the Node 24 line that smoke
test fails because the preparation-blob path cannot execute ESM, so the script
rebuilds the same asset as a CommonJS SEA. ESM SEA should become the published
format once the pinned Node line supports it in the release path.

Public releases require GitHub artifact attestations for release assets. Signed
checksums are the fallback only for environments where GitHub attestations are
unavailable.

Secondary distribution channels can come later:

- npm bin package for developer convenience.
- Homebrew tap for macOS/manual installs.
- Nix flake package for Nix users.

Docker or OCI actions are not the primary path because they do not solve host
Nix store or daemon access and do not help macOS runners.
