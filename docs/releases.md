# Binary releases

This document describes how cupboard's release workflow builds and publishes the
binaries installed by the GitHub actions. Nothing here is needed to use the
actions; see [docs/github-actions.md](./github-actions.md) for that. For how a
release reaches a running deployment, see [docs/deploying.md](./deploying.md).

## Upgrade notes

### Publication and attestation modes

The `push` and `attest` inputs of both reusable publish workflows take named
values instead of booleans. A caller that passes a boolean must change it when
it updates the workflow pin.

In the flake workflow, `push: true` becomes `push: built-and-reused`, which is
the default, and `push: false` becomes `push: none` with `attest: none`. The
simple workflow gains a `push` input. Its default, `all`, publishes every build
output, as the workflow did with the boolean inputs. In the simple workflow,
`attest: false` becomes `attest: none`.

With the boolean inputs, both workflows signed SLSA build provenance for every
published final output, and rebuilt cached final outputs to do so.
`attest: built` keeps that behaviour, so `attest: true` in the simple workflow
becomes `attest: built`. A flake caller that needs the same guarantee sets
`attest: built`. The default, `attest: all`, does not rebuild cached outputs.
For an output that the run did not build, it signs a build-origin statement,
which records how the run obtained the output, and no SLSA build provenance.

A workflow that calls `actions/attest` and `actions/attest-attach` directly must
pass the `receipt-file` output of `actions/attest` to `actions/attest-attach`,
not the build receipt. `actions/attest` can accept fewer subjects than the build
receipt lists, for example with `mode: built`, and `actions/attest-attach`
rejects a receipt whose subjects differ from the checksums.

### Attestation status for cached targets

With `attest: all`, the flake workflow's plan asks the destination which cached
targets have an attestation, through the cache's `attested-paths` read probe. A
server without that probe returns 404. The plan then warns and treats every
cached target as attested, so the run does not republish or attest cached
targets. Deploy the server before updating the workflow pin so that runs attest
cached targets that have no attestation.

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

An archive contains the `cupboard` executable and the `cupboard-hook-relay` hook
helper beside it, which is where the CLI looks for the helper. The publish
workflow tests an archive by unpacking it and running a consumer publication
with `CUPBOARD_RELEASE_ARCHIVE`. A defective packaged asset therefore fails CI
before it reaches a consumer job.

Each binary build tries the ESM format first. Esbuild emits an ESM bundle, the
SEA config sets `mainFormat: "module"`, and postject injects the blob into the
pinned Node binary. The workflow then runs `cupboard --version`,
`cupboard push --help`, and `cupboard config`. If that smoke test fails, the
script rebuilds the asset as a CommonJS SEA and tests it again. The pinned Node
release therefore determines which format is published.

Public releases require GitHub artifact attestations for release assets.

Secondary distribution channels can come later:

- npm bin package for developer convenience.
- Homebrew tap for macOS/manual installs.

Docker or OCI actions are not the primary distribution mechanism because they do
not solve host Nix store or daemon access and do not help macOS runners.
