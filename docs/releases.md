# Binary releases

How cupboard's release workflow builds and publishes the binaries that the
GitHub actions install. Nothing here is needed to use the actions; see
[docs/github-actions.md](./github-actions.md) for that.

## Release ordering

The upload protocol negotiates optional response fields explicitly. A new CLI
offers the `upload-grace-facts` capability in a request header. An old server
ignores that header, and the CLI falls back to the legacy report for an ordinary
retained push when the server does not acknowledge the capability. A new server
returns the legacy response shapes unless the client offered that capability, so
old CLIs keep working unchanged.

Features whose safety depends on an acknowledged capability still require a new
enough server. In particular, `cupboard push --no-retain` performs a
side-effect-free capability preflight and refuses to publish if the server does
not acknowledge grace facts. Deploying the server first makes that feature
available immediately, but is not required to keep ordinary retained pushes
working during a rolling release.

Each release publishes the following stable platform asset names:

- `cupboard-linux-x64.tar.gz`
- `cupboard-linux-arm64.tar.gz`
- `cupboard-macos-x64.tar.gz`
- `cupboard-macos-arm64.tar.gz`
- `checksums.txt`

Installers prefer these stable names, so release tags do not need to be valid
filenames. They retain lookup support for the older
`cupboard-vX.Y.Z-<platform>-<arch>.tar.gz` assets.

Each binary build tries the ESM format first: esbuild emits an ESM bundle, the
SEA config sets `mainFormat: "module"`, postject injects the blob into a pinned
Node 24 binary, and the result is smoke-tested with `cupboard --version`,
`cupboard push --help`, and `cupboard config`. On the Node 24 line that smoke
test fails because the preparation blob cannot execute ESM, so the script
rebuilds the same asset as a CommonJS SEA. ESM SEA should become the published
format once the pinned Node release line supports it.

Public releases require GitHub artifact attestations for release assets. Signed
checksums are the fallback only for environments where GitHub attestations are
unavailable.

Secondary distribution channels can come later:

- npm bin package for developer convenience.
- Homebrew tap for macOS/manual installs.
- Nix flake package for Nix users.

Docker or OCI actions are not the primary distribution mechanism because they do
not solve host Nix store or daemon access and do not help macOS runners.
