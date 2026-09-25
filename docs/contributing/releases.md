# Releasing

This page is for maintainers who publish cupboard releases.

## Publishing a release

1. If upgrading to this release needs anything beyond running `cupboard deploy`,
   add a section to [the upgrade notes](../operator/upgrade-notes.md) first.
2. Run the `release` workflow from the Actions tab, and give it the version
   number, such as `1.4.0`. The workflow builds the CLI for every platform and
   signs attestations for the archives. It then creates a draft GitHub release,
   or updates the existing draft, with the archives, a `checksums.txt` file and
   generated release notes.

   The release notes include the `nix.conf` lines for using the release cache.
   All of the cache's public keys go on one `extra-trusted-public-keys` line, so
   the lines still work while the cache's signing key is being rotated.

3. Review the draft and publish it. Publishing creates the tag. That starts the
   `release cache` workflow, which builds the tagged flake on every supported
   system, pushes the results to the release cache, and publishes the flake to
   FlakeHub.

When a repository calls one of the reusable workflows at a tag, the workflow
installs the cupboard release published at that tag. It first checks that the
release and the workflow were built from the same commit.

## The binaries

Each archive's name includes only its platform, not the version. This means that
a tag doesn't have to be a valid file name. The archives are:

- `cupboard-linux-x64.tar.gz`
- `cupboard-linux-arm64.tar.gz`
- `cupboard-macos-x64.tar.gz`
- `cupboard-macos-arm64.tar.gz`

Older releases used names such as `cupboard-vX.Y.Z-<platform>-<arch>.tar.gz`,
and the installers still recognise them.

Each archive contains two files: the `cupboard` executable, and a helper called
`cupboard-hook-relay`. `build-push` expects to find the helper in the same
directory as the executable.

The executable is a Node single executable application. `pnpm build:binary`
builds it in three steps:

1. It bundles the CLI and the Workers into a single CommonJS file with esbuild.
2. It injects that file into the pinned Node binary with postject.
3. It checks the result by running `cupboard --version`, `cupboard push --help`
   and `cupboard config`.

CI builds an archive for every change. It then runs a sample publishing run with
that archive, by setting `CUPBOARD_RELEASE_ARCHIVE`. If the packaging is broken,
CI fails before the problem can reach a release.
