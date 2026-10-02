# Releasing

This page is for maintainers who publish cupboard releases.

## Publishing a release

1. If upgrading to this release needs anything beyond running `cupboard deploy`,
   add a section to [the upgrade notes][upgrade-notes] first. Before running the
   release workflow, replace the `Next release` heading with the selected
   `v<major>.<minor>.<patch>` version and commit the notes with the release
   preparation changes.
2. Run the `release` workflow from the Actions tab, and give it the version
   number, such as `1.4.0`. The workflow builds the CLI for every platform and
   signs attestations for the archives. It then creates a draft GitHub release,
   or updates the existing draft, with the archives, a `checksums.txt` file and
   generated release notes.

   The release notes include the `nix.conf` lines for using the release cache.
   All of the cache's public keys go on one `extra-trusted-public-keys` line, so
   the lines still work while the cache's signing key is being rotated.

   New and updated drafts also link to the upgrade notes at the release tag. The
   link resolves after publishing creates the tag. Draft updates keep existing
   release notes and add the link if it is missing.

   Each platform job first checks the flake's reproducibility as described
   below. All four checks must pass before the workflow can assemble the draft.

3. Review the draft and publish it. Publishing creates the tag. That starts the
   `release cache` workflow, which builds the tagged flake on every supported
   system, pushes the results to the release cache, and publishes the flake to
   FlakeHub.

[upgrade-notes]: ../operator/upgrade-notes.md

When a repository calls one of the reusable workflows, the workflow's
`resolve-cupboard` step looks for a release that was published from the same
commit as the workflow, whichever tag or commit the caller used. If there is
one, the workflow installs that release. Otherwise it builds cupboard from the
workflow's commit. A caller that sets the workflow's `cupboard-version` input
gets that release instead.

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

Before building release archives, the `release` workflow verifies the unchanged
`.#cupboard` flake output on `x86_64-linux`, `aarch64-linux`, `x86_64-darwin`
and `aarch64-darwin`. Each runner obtains a candidate output with `nix build`,
then uses [`nix build --rebuild`][nix-rebuild] to build the same derivation
locally and compare the result with the candidate. The candidate and
dependencies may come from trusted substituters. The verification rebuild always
runs locally.

The comparison covers the installed CLI and `cupboard-hook-relay` helper in the
Nix store output. It does not compare the bytes of the release archives, which
are packaged separately with the requested release version.

A mismatch fails the platform job before archive attestation or upload and
blocks draft assembly. Correct the packaging cause before rerunning the release
workflow. To reproduce the check locally on the affected system, run:

```sh
nix build .#cupboard --no-link --option builders ''
nix build .#cupboard --no-link --rebuild --keep-failed --option builders ''
```

`--keep-failed` preserves the differing rebuild output for inspection. Nix
reports a reproducibility mismatch with exit status 104.

[nix-rebuild]:
  https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-build.html

CI builds and smoke-tests the executable for every change. The publishing
pipeline suite also builds its own release archive and publishes with that
installation. Set `CUPBOARD_RELEASE_ARCHIVE` to test an existing archive
instead. Packaging failures in either check block CI.
