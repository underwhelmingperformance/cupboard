# The Nix conformance suite

`packages/nix` re-implements a slice of Nix's own libstore client in TypeScript:
it discovers `nix.conf` the way Nix does, resolves which store backend to open,
queries binary caches, parses narinfo files, and partitions a closure into what
is already present, what can be substituted, and what has to be built. Every one
of those answers has to match what the real client would have said, and the way
we know is by asking a real `nix` the same question.

That is what this suite is. Each case sets up one fixture, puts a question to
our client and to a `nix` binary, and compares the two answers. No expected
value is written down by hand, so a divergence fails whether it arrived in a
change of ours or in a new version of Nix.

## Running the suite

```sh
pnpm test:conformance
```

It needs a working Nix on the machine. CI runs it in the `e2e` job, which
already installs one.

## The oracle

The `nix` a case compares against is the one this repository's flake pins, not
whatever the machine happens to have on its `PATH`. The flake exposes it as the
`conformanceNix` output, built from the pinned nixpkgs, and the suite resolves
it with:

```sh
nix build .#conformanceNix --no-link --print-out-paths
```

Each test file resolves it once and shares the result across its cases. A
machine that cannot build it fails the suite, so an absent oracle never reads as
a pass.

Which `nix` that is comes from [`tests/conformance/oracle.json`], which pairs
the version string the output resolves to with the nixpkgs revision it was built
from. That file is canonical: it is the one place the version is written down,
and the suite fails rather than running a case if the flake builds something the
record does not name.

Two guards keep the record honest:

- `pnpm check:conformance-oracle` compares the recorded nixpkgs revision against
  `flake.lock`. It reads two files and needs no Nix, so it runs as part of
  `pnpm check` on every machine and in CI.
- The suite itself compares the resolved binary's `nix --version` against the
  recorded version, which catches the same nixpkgs revision building a different
  `nix`.

### The generated settings table

`pnpm update:conformance-oracle` also writes
[`packages/nix/src/setting-types.generated.ts`], which the client reads to
decide whether Nix would accept a value. It holds two things the pinned Nix is
asked for.

The first is the kind of value each setting holds, read from
`nix config show --json`.

The second is the width Nix declared each integer setting with. Nix reads an
integer setting into a fixed C++ width and refuses a number that width could not
hold, and it reports none of this, so the width is settled by asking: the update
puts four values to each integer setting, one at the edge of each candidate
width, and records the width the accepted set names. That is four
`nix config show` runs per integer setting, around twenty-five seconds for the
whole table, and it happens only when the pin moves.

A combination of accepted values that names no width the script knows fails the
update rather than guessing, so a Nix that adds a width asks for a reader rather
than silently recording the wrong bounds.

### Bumping the oracle

Moving the pin is a reviewed change, in two steps:

```sh
nix flake update
pnpm update:conformance-oracle
```

Commit `flake.lock` and `tests/conformance/oracle.json` together. Bumping one
without the other fails `pnpm check`.

Cases that start failing after a bump are the point of the exercise: each one is
a place where the new Nix answers differently from the old, and it wants reading
before it is made to pass.

## What a case asserts

Every case states which of two shapes it uses, because they mean different
things.

**Directional** cases compare acceptance against rejection: whatever the oracle
rejects, our client must reject too. Rejecting more than the oracle does is
conformant and passes; rejecting less fails. Our client targets the strictness
of Nix master, and the pinned oracle is behind it, so the oracle sets the
minimum rather than the exact answer.

**Exact** cases compare values: the fields both sides parsed out of an input
they both accepted, and the settings both sides resolved from one configuration.
These are equalities, asserted on whole objects.

## The resolved configuration

`discoverNixStoreConfig` reads `nix.conf`, `NIX_CONFIG` and the environment and
resolves the settings that decide what may be substituted and from where, where
a derivation is built, how a transfer is attempted, and whose signature is
accepted. `nix config show --json` answers the same question, so a case writes
one fixture, puts it to both sides in one environment, and compares.

Nix reports its own settings in its own names, units and shapes, so the two
sides meet through an adapter table in `tests/conformance/configuration.ts`.
Each entry names one field of the resolved configuration, the settings the
oracle answers it from, and the arithmetic between them. Most are direct, and
the ones that are not carry their reason:

- `stalledTransferTimeoutMs` holds milliseconds where `stalled-download-timeout`
  counts seconds.
- `building.systems` is the set of every system a build could be taken by, which
  Nix keeps as `system` and `extra-platforms` separately.
- `builders` holds the entries themselves, where the setting may name a machines
  file with `@`. The adapter follows that indirection the way Nix does when it
  dispatches a build.
- Settings Nix keeps as sets are reported sorted, so both sides are sorted
  before the comparison and it is the members that are compared. `substituters`
  is the exception: it is tried in order, so it is compared as written.

### The unmodelled report

The four groups do not model every setting in their own domains. A case lists
the ones they leave out, annotates them into the test output, and asserts the
list, so a setting cannot become modelled, or be dropped by Nix, without the
record moving with it. A second case asserts that every setting the table claims
is one the oracle really reports, which is what catches a rename.

Our client also carries fields for Nix's renamed transfer retry settings, which
the pinned oracle predates. A third case asserts those settings are still absent
from the oracle, so the rename arriving in a bumped oracle fails and asks for
the mapping rather than passing quietly.

## Narinfo read from a substituter

Our substituter client reads a narinfo the way libstore does, and a value it
lets through is one Nix would refuse the whole document over: a path counted as
available on the strength of one is a path Nix would then decline to fetch. A
case writes one narinfo and a `nix-cache-info` into a directory, serves it as a
`file://` cache, and asks both sides about the path it describes.

The cache is served from a directory rather than over HTTP for a reason. Nix
keeps a disk cache of the narinfos it has read from a substituter and answers
from it for as long as the narinfo TTL settings allow, so an HTTP fixture would
be answered from a previous case. A `file://` store bypasses that cache, so each
case observes the document it just wrote.

```sh
nix path-info --store file://<dir> --json --json-format 1 <path>
```

`--json-format 1` is pinned so a later format cannot quietly change what a field
means. The three answers the comparison rests on are Nix's own: a document it
reads gives a JSON object and a zero status, a path the cache holds nothing for
gives a null entry and a zero status, and a document it refuses gives a non-zero
status with its reason on stderr. Our client answers the same three ways, with a
refusal arriving as `SubstituterAnswerUnreadableError` because the query runs
with `fallback` off.

Acceptance is **directional**: whatever Nix refuses, our client has to refuse
too, and refusing more is conformant. A case that fails prints the reason Nix
gave as a test annotation, so the exit status is what is asserted and the
message is only reported.

For a document both sides took, the offer is compared **exactly**: the NAR hash,
the NAR size, the download size, the references, the deriver and the signatures.
Two of those need normalising, and the adapter says so where it does it. Nix
reports a NAR hash SRI-encoded, which our own hash renders from the digest it
holds. A narinfo carrying no `FileSize` states no download size, which Nix
reports by leaving the field out and our client reports as a zero.

## What a store can obtain

Three questions decide what a plan does with a path: which paths the
substituters offer, how realising a target splits into work to build and work to
fetch, and whether a consumer would actually obtain a closure from a cache. Nix
answers all three, so the cases put each one to both sides.

The fixture builds a small closure in the host store, signs a `file://` cache
holding it with a key it generates, and realises into a fresh `local?root=`
store per case, so no case is answered by what an earlier one fetched.
Substitution into such a store needs no daemon, which is why the suite can drive
it directly.

The closure's root is a built output rather than a file written by evaluation,
and that matters. Nix takes a content-addressed path from a cache whatever
signed it, because the path name commits to the contents, so a fixture made only
of `builtins.toFile` paths would be fetched even under a key that signed
nothing. The root is input-addressed, so the signature check bites on both
sides.

Each question has its own oracle:

- The offered paths are compared against `nix path-info --store file://<dir>`.
  The fixture cache advertises `WantMassQuery`, as a published cache does,
  because a cache that does not invite a batch is never given one and the
  comparison would then be about the flag rather than about what the cache
  holds.
- The partition is compared against `nix-store --realise --dry-run`, over the
  same targets in the same store.
- The closure verdict is compared against whether `nix-store --realise` with
  `require-sigs` on actually succeeds. The oracle is the fetch itself, so the
  verdict answers to what happened rather than to a prediction.

### The one message the suite reads

A dry run writes its plan to stderr and exits zero whichever way it goes, and
nothing structured reports the same thing. This is the suite's only dependency
on the text of a Nix message, and the parse is written to survive Nix rewording
around it: it finds each of the three headings by the words that distinguish it,
taking the singular and plural forms alike, and reads the paths indented
underneath. The download and unpacked figures a heading carries are never read.

## The store a configuration selects

`nix config show` reports the `store` setting as it was written;
`nix store info` reports the store the configuration resolved to. That
resolution is what `resolveStoreBackend` answers, so `store info` is its oracle.
A case puts one environment to both sides and compares which store each
selected.

Nix prints the resolved URL before it connects, so a configuration naming a
daemon socket nothing is listening on still says which store was selected. The
cases read the URL and not the exit status, because selecting a store and
reaching it are separate questions and only the first is being asked.

What the two sides can both state is the backend. Nix writes the store's
directories into the URL only when they came from the URI's own parameters, so
directories the environment names leave a plain `local`, and the daemon at its
usual socket is written `daemon` where one at any other socket is written as the
`unix://` URL naming it. Both of those are the daemon store.

One case gives no overrides at all, so the machine's own filesystem decides:
whether its state directory can be written, and whether a daemon is listening.
Neither side is told the answer, which makes it a real comparison of the
automatic selection wherever the suite runs.

### The store Nix falls back to

Nix sets up a store of the user's own for a Linux machine that has no Nix
directories, and offers it only when nothing else could have been meant: a
machine holding a Nix state directory has an install that names its own
directories, so the fallback is off. Every machine with Nix installed holds one,
which is every machine this suite runs on. The case therefore reports itself as
skipped, naming which condition ruled it out, rather than passing on a
comparison it never made.

## Isolation

A case must observe its own fixture and nothing else, so every Nix invocation
runs under `isolatedEnvironment` from `tests/support/nix.ts`: an empty system
`nix.conf` under a temporary `NIX_CONF_DIR`, and `NIX_USER_CONF_FILES` pointed
at `/dev/null` so no user configuration is read at all. Fixtures live in
temporary directories from `tests/support/filesystem.ts`, which are removed when
the case finishes.

The one invocation that runs with the machine's own environment is the flake
build that resolves the oracle, which needs the machine's substituters to fetch
it.

## Known fragilities

- CI runs the suite on ubuntu only. Configuration behaviour that differs on
  darwin is therefore checked on developer machines rather than on every pull
  request.
- Resolving the oracle evaluates the flake from the working tree. An uncommitted
  change makes Nix warn about a dirty tree, which is harmless here, and it does
  mean the resolution is not free on the first run of a session.
- Which settings count as being in the four groups' domains is written out in
  `tests/conformance/configuration.ts`, because `nix config show` carries no
  statement of what a setting is for. A Nix that adds a setting to one of those
  domains therefore joins the list by review when the oracle is bumped, rather
  than announcing itself.
- The adapter follows a `builders` setting's `@file` indirection with its own
  reading of the machines-file rules, which is the same reading our client
  makes. A case comparing the two would agree on a rule both got wrong.
- Reading `nix config show` needs the `nix-command` experimental feature, which
  the isolated configuration does not enable, so the invocation asks for it on
  the command line. That leaves `experimental-features` assigned on the oracle's
  side alone; no mapped field reads it.
- `nix path-info` refuses a narinfo whose signature cannot be decoded, which the
  narinfo parser on its own would take. The narinfo cases therefore describe the
  acceptance of the whole read rather than of the parser alone, which is the
  acceptance our client's own query has to match.
- Reading a dry run's plan means reading the text Nix wrote, as described above.
  A Nix that renames a heading fails those cases, which is the intended outcome,
  but it fails them as a parse returning nothing rather than as a clear
  mismatch.
- The availability fixture builds into the host store, the only store that
  builds on every platform, so it leaves a handful of paths there. They are
  ordinary garbage-collectable paths, and the end-to-end suite does the same.
- Our client asks for a trusted signature on a content-addressed path where Nix
  waives one. That difference is deliberate and `offer-acceptance.ts` states
  why, so the closure cases use an input-addressed root rather than asserting
  over the waiver.
- The store Nix falls back to cannot be exercised on a machine that has Nix
  installed, which is every machine the suite runs on. Its case is always
  reported as skipped, so that code path is covered by the unit tests alone.

[`packages/nix/src/setting-types.generated.ts`]:
  ../packages/nix/src/setting-types.generated.ts
[`tests/conformance/oracle.json`]: ../tests/conformance/oracle.json
