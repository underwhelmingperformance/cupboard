### x86-64 macOS is no longer supported

From this release, cupboard no longer builds, tests or publishes anything for
x86-64 macOS (`x86_64-darwin`), because it could not test that system reliably.
The release has no `cupboard-macos-x64.tar.gz` archive, the flake has no
`x86_64-darwin` outputs, and the release cache has no `x86_64-darwin` builds.
Earlier releases keep their `cupboard-macos-x64.tar.gz` archives.

In this note, "the last release before this one" is the newest release that
includes the x86-64 macOS archive. Its version is not known until this release
is published, so look for it in the list of releases.

#### Operators and other CLI users

The CLI binary contains both Workers. An x86-64 macOS machine has no CLI binary
from this release, so its existing CLI can only deploy the release that it came
from. From this release on, run `cupboard deploy` and the deployment commands
from Linux or from macOS on Apple silicon. `deployment status` and
`deployment resume` must come from the same release as the deployed control
Worker. See [Upgrading][upgrading].

Tenant administrators and people who push from an x86-64 Mac can keep using the
CLI from the last release before this one. That works only until a release
requires a CLI from its own release, and then they must run the CLI from Linux
or from macOS on Apple silicon.

The deployed Workers don't depend on the operator's platform.

#### CI jobs

The cupboard GitHub Actions and reusable workflows fail at the start of each job
that runs on an x86-64 macOS runner, with the error
`x86_64 macOS is not supported`. The check looks only at the runner, so a new
version of the action refuses it whichever `cupboard-version` you pin, and also
when the job supplies its own binary through `cupboard-path`.

To keep an x86-64 macOS runner working, pin both of these:

- the action or workflow to a ref from the last release before this one, and
- `cupboard-version` to that release or an earlier one, because this release has
  no x86-64 macOS archive.

The pinned CLI works only until a release requires a CLI from its own release.
After that, or if you prefer not to pin, move the job to an arm64 macOS runner
(such as `macos-15`) or a Linux runner.

Flake targets for `x86_64-darwin` can still be built. Either set the target's
`os` to an arm64 macOS runner such as `macos-15`, which builds `x86_64-darwin`
through Rosetta where Rosetta is installed, or set `remote = true` on the target
and list an `x86_64-darwin` machine in the workflow's `builders` input. Reading
a cache with Nix, including with the Home Manager module, still works on an
x86-64 Mac.

[upgrading]: ../upgrading.md
