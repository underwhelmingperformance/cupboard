# Measuring what a publication costs

`scripts/measure-realisation` reports what realising a flake's targets would
cost a runner that starts with nothing in its store: how many derivations it
would build, how many paths it would fetch, and how many bytes those paths are
compressed and unpacked. It reports those numbers for each target on its own and
for the targets a manifest groups together, because the difference between the
two is the reason to group targets. Targets that share most of a closure cost
that shared work once when realised together, and once per target when realised
separately.

The command reads the same target manifest as the publish workflow, so it can be
pointed at a repository's real publication and report what that publication
costs. Its JSON output is exact, so it doubles as a regression gate: record a
run's numbers, and a later run fails when a measurement grows past what was
recorded.

## What it measures against

Every measurement uses a fresh, empty physical store directory while preserving
the machine's logical store directory. The logical directory must remain
`/nix/store` because it contributes to store-path hashes. Pointing Nix at
another logical directory changes every derivation hash, so the result no longer
represents a real runner.

Nix cannot plan a build in a store that holds none of the derivations, so the
command copies each target's derivation closure into the empty store before
measuring. That copy is local disk to local disk and costs a real runner
nothing: a runner evaluates the flake into the same store it builds in, so its
derivations are already there.

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
Pass `--report-file /dev/stdout` to read the JSON directly.

Two targets sharing a `cohort` label become a group, reported alongside what its
members cost measured one at a time. The whole manifest is measured as one group
as well, under `all-targets`, whenever it holds more than one target.

Other options:

- `--substituter <url>`, repeatable, replaces the list every measurement is
  taken against. It defaults to `https://cache.nixos.org`.
- `--work-dir <path>` puts the diverted store at a chosen path instead of a
  fresh temporary directory. Nix refuses a store directory reached through a
  symlink, so the command resolves the path before use.
- `--keep-store` leaves the diverted store behind. Nix writes everything
  read-only, so removing such a store by hand needs `chmod -R u+w` first.

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
equal to its baseline value plus the tolerance. If a measurement exceeds its
budget, the command reports the measurement, budget and excess, then exits 65.
`unknown` has no budget because it counts paths unavailable from every queried
substituter and therefore depends on network state.

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
