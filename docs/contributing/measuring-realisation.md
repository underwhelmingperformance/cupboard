# Measuring what a publication costs

`pnpm measure:realisation` estimates how much work it takes to build a flake's
targets from nothing. For each target, it reports:

- how many derivations Nix would build;
- how many store paths Nix would download from a substituter;
- the compressed size of those downloads;
- the uncompressed NAR size of those paths.

The command is a development tool that you run from a checkout of this
repository. It isn't part of the released CLI. The flake publish workflow sizes
its cohorts with a different command, `cupboard plan measure`.

The command measures each target on its own. It also measures groups of targets
together. Targets in a group often share dependencies. A group's measurement
counts that shared work once, but the separate measurements for the targets
count it once for each target.

The command reads the same target manifest as the publish workflow, so you can
point it at a repository's real manifest and see what publishing it costs. Its
JSON report contains exact numbers. This means you can also use it as a
regression test: save a report, and a later run fails if a measurement has grown
past the saved value.

## How it measures

### An empty store

Each measurement starts from a new, empty store, in a temporary directory. Nix
stores still record their paths under `/nix/store`, because the store directory
is part of every store path's hash. If Nix used a different store directory,
every derivation would get a different hash, and the result wouldn't match what
a real CI runner does. So the command keeps `/nix/store` as the store directory,
and only moves where the files are kept on disk.

Nix can't plan a build in a store that has none of the derivations. Before
measuring, the command copies each target's derivation and everything that it
depends on into the empty store. The report doesn't count this copy. On a real
runner, Nix evaluates the flake in the store that it builds in, so the
derivations are already there.

### Its own substituters

The command replaces the list of substituters, so your machine's Nix
configuration doesn't affect the result. For example, if your machine has an
`ssh://` substituter, Nix would otherwise open an SSH connection every time it
checked whether a path was available.

### Using the daemon client

The command gets its counts and sizes from this repository's Nix daemon client.
It starts `nix daemon --stdio` for the temporary store, and asks the daemon what
building each set of installables would cost.

The daemon protocol can't evaluate flake attributes or copy derivations, so the
command runs `nix` directly for those two operations. That code is in
`scripts/measure-realisation/diverted-store.ts`.

## Running it

First, write a manifest. You can use the publish workflow's targets array as it
is, or put the same array under a `targets` key:

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

Then run the command:

```sh
pnpm measure:realisation \
  --flake nixpkgs \
  --targets-file targets.json \
  --report-file realisation.json
```

The command prints a summary to standard output and writes the exact numbers to
the report file. If you pass `--report-file /dev/stdout`, the JSON and the
summary both go to standard output, one after the other, so the output isn't
valid JSON on its own.

### Groups

Targets with the same `cohort` label form a group. The report shows the group's
measurement next to the measurements of its targets on their own. If the
manifest has more than one target, the command also measures all of them
together, as a group called `all-targets`.

### Other options

- `--substituter <url>` sets the substituters that every measurement uses. You
  can pass it more than once. The default is `https://cache.nixos.org`.
- `--work-dir <path>` creates the temporary store in this directory instead of a
  new temporary directory. The path must not exist yet. The command creates it
  and deletes it at the end. Make sure no other process writes to it while the
  command runs.
- `--keep-store` keeps the temporary store when the command finishes. Nix makes
  the store's contents read-only, so run `chmod -R u+w` on it before you delete
  it.

## Using it as a regression test

Save a run's report, then pass it to a later run as the baseline:

```sh
pnpm measure:realisation \
  --flake nixpkgs \
  --targets-file targets.json \
  --baseline realisation.json \
  --tolerance 0.05
```

Four measurements have a budget: `willBuild`, `willSubstitute`, `downloadSize`
and `narSize`. Each budget is the baseline value multiplied by one plus the
tolerance, rounded down to a whole number. With a tolerance of 0.05, a
measurement can grow by up to 5%.

If any measurement is over its budget, the command prints the measurement, the
budget and how far over it is, and exits with status 65.

`unknown` has no budget. It counts paths that none of the substituters could
provide, so it depends on the state of the network when you run the command.

If a target or group has no entry in the baseline, the report marks it as
unbudgeted, and it can't fail the run. Save a new baseline to give it a budget.

The report also records how long evaluation and planning took. These times help
you find which part of a slow run takes longest. They have no budget, because
they change from run to run in a way that the counts don't.

## Tests

The unit tests in `scripts/measure-realisation` cover parsing, combining
measurements, and building `nix` command lines. They use a fake planner, so they
don't need Nix.

`tests/e2e/measure-realisation.test.ts` runs the command for real. It measures
`hello` and `cowsay` from the nixpkgs revision in `flake.lock`, and skips if
`nix` isn't on your `PATH`. To try the command against a different flake, use
the command's `--flake` option.
