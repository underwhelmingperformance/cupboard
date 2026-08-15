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

Every measurement is planned against a store that keeps the machine's real
logical store directory but holds its contents in a fresh, empty directory. The
logical directory has to stay `/nix/store` because a store path's hash covers
it. If Nix is pointed at a plain directory instead, every derivation hash
changes, so nothing substitutes and the measurement describes a store that no
runner would ever have.

Nix cannot plan a build in a store that holds none of the derivations, so the
command copies each target's derivation closure into the empty store before
measuring. That copy is local disk to local disk and costs a real runner
nothing: a runner evaluates the flake into the same store it builds in, so its
derivations are already there.

The substituter list is replaced rather than extended, so the answer does not
depend on what the machine running the command happens to have configured. A
developer machine with an `ssh://` substituter would otherwise open an ssh
connection for every availability query.

The counts and byte totals come back over the Nix store protocol, through this
repository's own daemon client: the command starts `nix daemon --stdio` on the
diverted store and asks the daemon what realising each set of installables would
require. Evaluating a flake attribute and copying a derivation closure are not
operations that protocol offers, so those two go through the `nix` command, in
`scripts/measure-realisation/diverted-store.ts` and nowhere else.

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

Each of `willBuild`, `willSubstitute`, `downloadSize` and `narSize` is held to
the value the baseline recorded, plus the tolerance. A measurement above that is
a breach, and the run prints which measurement breached, what its budget was,
and by how much it went over, then exits 65. `unknown` is not held to a budget:
it counts the paths that no substituter answered for, which depends on the
network the measurement ran on.

A target or group with no entry in the baseline is reported as unbudgeted and
never breaches a budget, so adding a target does not fail the first run that
includes it; record a new baseline to give the target a budget.

The report also records evaluation and planning times. They show which phase of
a slow run takes the time. They are not held to a budget, because they are not
reproducible the way the counts are.

## Tests

The parsing, the aggregation and the `nix` command construction are covered by
unit tests in `scripts/measure-realisation`, which need no Nix: the planner is
an interface and the suites drive it with injected answers.
`tests/e2e/measure-realisation.test.ts` runs the real thing and skips when `nix`
is not on the path. It measures `hello` and `cowsay` from the exact nixpkgs
revision in `flake.lock`; use the command's `--flake` option for experiments
against another flake.
