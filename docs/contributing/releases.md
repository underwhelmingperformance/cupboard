# Releasing

This page is for maintainers who publish cupboard releases.

## Publishing a release

1. Add any new upgrade instructions in `docs/operator/upgrade-notes/*.md`
   alongside the changes that require them. Use descriptive filenames without
   release versions. Each draft includes files added or changed since the
   preceding published release on its source history. An updated file is
   included in full, so it should describe one related set of upgrade steps.
   Unchanged files are not repeated. The first release includes all files.

2. Run the `release` workflow from the Actions tab and enter the version, with
   or without the lowercase `v` prefix. The workflow builds the CLI for every
   platform and signs attestations for the archives. It creates or updates a
   draft GitHub release with the archives, a `checksums.txt` file, generated
   release notes and the upgrade instructions. No source preparation or
   versioning commit is needed.

   The release notes include the `nix.conf` lines for using the release cache.
   All of the cache's public keys go on one `extra-trusted-public-keys` line, so
   the lines still work while the cache's signing key is being rotated.

   Draft updates preserve text outside the generated upgrade section. Review
   that section after a rerun because the workflow refreshes it from the
   selected source revision. Relative links in upgrade instructions point at the
   tagged source and resolve when the release is published.

   Each platform job first checks the flake's reproducibility as described
   below. All four checks must pass before the workflow can assemble the draft.

3. Review the draft and publish it. Publishing creates the tag. That starts the
   `release cache` workflow, which builds the tagged flake on every supported
   system, pushes the results to the release cache, and publishes the flake to
   FlakeHub.

The release-cache workflow calls `cupboard-publish.yml@main` and leaves
`cupboard-version` unset. The resolver selects the CLI from the exact commit of
that workflow. The workflow builds the tagged release source; the publishing
tool follows main. Re-running all jobs resolves the current workflow on main.
Re-running failed jobs or a specific job uses the workflow commit from the first
attempt. After a publication fix on main, re-run all jobs to use that fix. See
[GitHub's rerun behaviour][workflow-reruns].

[workflow-reruns]:
  https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#behavior-of-reusable-workflows-when-re-running-jobs

The tenant's release trust rule permits that workflow at `refs/heads/main`, with
release events, repository identity and grants scoped to the release cache and
release roots. The rule applies to future releases without per-release rotation.
[Guided trust checks][trust-checks] inspect and repair the workflow's required
grants.

[trust-checks]: ../ci/github-check.md

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
