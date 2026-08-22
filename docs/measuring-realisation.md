# Measuring what a publication costs

`scripts/measure-realisation` estimates the work required to realise a flake's
targets in an empty store. It reports the derivations that Nix would build, the
paths it would fetch, their compressed download size, and their uncompressed NAR
size. The report measures each target separately and each group in the manifest.
When targets share a closure, the grouped measurement counts that work once; the
separate measurements count it once per target.

The command reads the same target manifest as the publish workflow, so it can be
pointed at a repository's real publication and report what that publication
costs. Its JSON output is exact, so it doubles as a regression gate: record a
run's numbers, and a later run fails when a measurement grows past what was
recorded.

## What it measures against

By default, every measurement uses a fresh, empty physical store directory while
preserving the machine's logical store directory. The logical directory must
remain `/nix/store` because it contributes to store-path hashes. Pointing Nix at
another logical directory changes every derivation hash, so the result no longer
represents a real runner.

Nix cannot plan a build in a store that contains none of the derivations, so the
command copies each target's derivation closure into the empty store before
measuring. The report excludes that local copy because a runner evaluates the
flake in the store where it builds, so the derivations are already present.

The command replaces the substituter list, so the result does not depend on the
machine's existing configuration. A developer machine with an `ssh://`
substituter would otherwise open an SSH connection for every availability query.

The command obtains counts and byte totals through this repository's daemon
client. It starts `nix daemon --stdio` for the diverted store and queries the
cost of realising each set of installables. The store protocol cannot evaluate
flake attributes or copy derivation closures, so only those operations invoke
`nix` directly, in `scripts/measure-realisation/diverted-store.ts`.

## Running it

Write a manifest. It is the publish workflow's own targets array, or that same
array under a `targets` key:

```json
[
  {
    "attr": "hello",
    "system": "x86_64-linux",
    "os": "ubuntu-latest",
    "remote": false,
    "rootSuffix": "hello",
    "cohort": "tools"
  },
  {
    "attr": "cowsay",
    "system": "x86_64-linux",
    "os": "ubuntu-latest",
    "remote": false,
    "rootSuffix": "cowsay",
    "cohort": "tools"
  }
]
```

Then measure it:

```sh
pnpm measure:realisation \
  --flake nixpkgs \
  --targets-file targets.json \
  --report-file realisation.json
```

The summary goes to standard output and the exact numbers to the report file.
Passing `--report-file /dev/stdout` writes the JSON followed by the human
summary to the same stream, so the output is not a standalone JSON document.

Two targets sharing a `cohort` label become a group, reported alongside what its
members cost measured one at a time. The whole manifest is measured as one group
as well, under `all-targets`, whenever it contains more than one target.

Other options:

- `--substituter <url>`, repeatable, replaces the list every measurement is
  taken against. It defaults to `https://cache.nixos.org`.
- `--work-dir <path>` creates a fresh parent for the diverted store instead of
  using a temporary parent. The path must not exist and must not be a symlink.
  The actual store is an unpredictable child of that parent. Cleanup verifies
  the child's directory identity and ownership marker, then recursively removes
  only the child. It removes the parent with `rmdir`, which refuses a non-empty
  directory. A mismatched child remains in a holding directory whose path is
  included in the error.
- `--keep-store` leaves the parent and its diverted-store child behind. Nix
  writes the child contents read-only, so removing the store by hand needs
  `chmod -R u+w` first.

Cleanup assumes that another process running as the same user does not change
the private child while cleanup is traversing it. Node does not provide a
portable handle-relative recursive removal API for Darwin and Linux. Do not run
a measurement with another process that can write to its work directory.

## Using it as a gate

Record a run's report and pass it back as the baseline:

```sh
pnpm measure:realisation \
  --flake nixpkgs \
  --targets-file targets.json \
  --baseline realisation.json \
  --tolerance 0.05
```

Each of `willBuild`, `willSubstitute`, `downloadSize` and `narSize` has a budget
equal to the baseline multiplied by one plus the tolerance, rounded down to a
whole number. If a measurement exceeds its budget, the command reports the
measurement, budget and excess, then exits 65. `unknown` has no budget because
it counts paths unavailable from every queried substituter and therefore depends
on network state.

A target or group with no baseline entry is reported as unbudgeted and does not
breach a budget. Record a new baseline to give it a budget.

The report also records evaluation and planning times. They show which phase of
a slow run takes the time. They are not held to a budget, because they are not
reproducible the way the counts are.

## Tests

Unit tests in `scripts/measure-realisation` cover parsing, aggregation and `nix`
command construction. They inject a planner implementation, so they do not
require Nix. `tests/e2e/measure-realisation.test.ts` runs the real thing and
skips when `nix` is not on the path. It measures `hello` and `cowsay` from the
exact nixpkgs revision in `flake.lock`; use the command's `--flake` option for
experiments against another flake.
