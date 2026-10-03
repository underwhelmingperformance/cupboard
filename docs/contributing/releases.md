# Releasing

This page is for maintainers who publish cupboard releases.

## Publishing a release

1. Select the actual canonical release tag, `v<major>.<minor>.<patch>`. If
   upgrading needs anything beyond running `cupboard deploy`, add the
   instructions under `Next release` in [the upgrade notes][upgrade-notes].
   Replace `vX.Y.Z` below with the selected tag, then run:

   ```sh
   VERSION=vX.Y.Z node --experimental-transform-types \
     --disable-warning=ExperimentalWarning scripts/release.ts prepare
   ```

   Preparation pins the release-cache reusable workflow to that exact tag,
   removes its separate CLI version override, and versions pending upgrade
   notes. Commit both preparation files before dispatching the release workflow
   with the same version. The release workflow checks this preparation before
   any platform build begins; draft publication checks it again before making
   GitHub API requests. The checked-in `@main` reference is an unprepared state,
   not a release pin. The main-branch dogfood workflow continues to use `@main`.

   Preparation changes the current checkout. Older tags retain their original
   workflows and trust requirements; the command does not rewrite them.

2. Prepare the matching release trust rule before publishing the draft. The
   preparation command prints the exact `job_workflow_ref` selector:
   `underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/vX.Y.Z`.
   Set `RELEASE_TENANT_URL` to the tenant URL in `release-cache.yml`, and obtain
   `PRECEDING_RELEASE_RULE_ID` from the rule list:

   ```sh
   cupboard oidc-trust list "$RELEASE_TENANT_URL"
   cupboard oidc-trust show "$RELEASE_TENANT_URL" "$PRECEDING_RELEASE_RULE_ID"
   ```

   Prepare `release-trust-rule.json` from that rule's `issuer`, `audience`,
   `claims`, `permittedGrants` and optional `display`. Change only
   `claims.job_workflow_ref` to the exact selector printed for the selected tag.
   Preserve the repository IDs, `event_name=release`, `ref_type=tag`, other
   claims, actions, release-cache binding and retention-root binding. Do not
   copy server-generated fields such as the rule ID or timestamps into the add
   body. Review the complete replacement before adding it:

   ```sh
   cupboard oidc-trust add "$RELEASE_TENANT_URL" --from-file release-trust-rule.json
   ```

   Use the returned ID as `REPLACEMENT_RELEASE_RULE_ID`, inspect the added rule,
   then disable the preceding release rule:

   ```sh
   cupboard oidc-trust show "$RELEASE_TENANT_URL" "$REPLACEMENT_RELEASE_RULE_ID"
   cupboard oidc-trust remove "$RELEASE_TENANT_URL" "$PRECEDING_RELEASE_RULE_ID"
   ```

   Disabling the preceding rule stops authorisation through its old selector.
   Reruns of older releases need a reviewed rule for their original workflow
   reference. Leave the main-branch dogfood rule unchanged. The preparation
   command does not add, disable or otherwise change trust rules.

3. Run the `release` workflow from the Actions tab, and give it the version
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

4. Review the draft and publish it. Publishing creates the tag. That starts the
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
