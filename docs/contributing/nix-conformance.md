# The Nix conformance suite

`packages/nix` reimplements part of Nix's store client (libstore) in TypeScript.
It does five things that Nix itself also does:

- finds and reads `nix.conf`;
- works out which store to use;
- asks binary caches which paths they have;
- parses narinfo files;
- splits a closure into paths that are already present, paths that can be
  downloaded, and paths that must be built.

If our client disagrees with Nix about any of these, cupboard can make wrong
decisions, such as reporting that a path can be downloaded when Nix would refuse
it. The conformance suite checks our client against a real `nix` binary.

Each test sets up one fixture, runs the same operation through our client and
through `nix`, and compares the results. The expected results therefore come
from Nix, not from values written into the tests. If our code changes behaviour,
or a new version of Nix does, the test fails.

## Running the suite

```sh
pnpm check:conformance
```

The suite needs a working Nix installation. CI runs it on every system listed in
[`packages/nix/src/nix-systems.json`].

## The reference Nix binary

The suite always compares against a specific `nix` binary, which the
repository's flake pins. It never uses whichever `nix` happens to be on your
`PATH`. The tests call this pinned binary the **oracle**. The flake provides it
as the `conformanceNix` output, and the suite finds it with:

```sh
nix build .#conformanceNix --no-link --print-out-paths
```

Each test file builds the output once and uses it for all of its tests. If the
machine can't build the output, the suite fails instead of skipping the
comparison.

[`tests/conformance/oracle.json`] records which Nix version to expect on each
supported system. The suite asks the oracle for `builtins.currentSystem`, and
uses that to choose the expected version and the matching settings table (see
below). If the flake produces a different version, the suite refuses to run.

Two checks keep these records in step:

- `pnpm check:conformance-oracle` checks that each version in `oracle.json`
  matches its generated settings table. It doesn't run Nix.
- The conformance suite checks that the oracle's `nix --version` output matches
  the recorded version. It then compares the whole generated settings table with
  the setting types that the oracle reports, and with the integer widths that
  the oracle accepts.

### The generated settings tables

`pnpm update:conformance-oracle` writes a settings table for each system, in
`packages/nix/src`. Our client uses the table for the platform and architecture
that it's running on to decide whether Nix would accept a value for a setting.

The update command gets two pieces of information about each setting from the
pinned Nix binary:

- The setting's type. The command reads this from `nix config show --json`.
- The width of an integer setting. Nix stores each integer setting in a C++
  integer type of a fixed size, and rejects values that don't fit. Nix doesn't
  report that size. The command tries four boundary values for each integer
  setting, and works out the width from which of them Nix accepts. This takes
  four runs of `nix config show` for each integer setting.

The oracle test runs the same checks on the system that it's running on. When
you update the flake lock, the generated table only changes if that system's
pinned Nix has different setting types or integer widths.

If the accepted values don't match any known width, the update fails. When that
happens, Nix has added a new integer width, and the code that reads the table
needs updating.

### Updating the pinned Nix

Update the flake lock, then run the conformance suite:

```sh
nix flake update
pnpm check:conformance
```

If the pinned Nix version or its settings changed, regenerate the records:

```sh
pnpm update:conformance-oracle
```

The update command asks Nix for a small probe derivation for every supported
system. Nix can build each probe locally, download it, or send it to any
configured remote builder. The command doesn't look at the host system and
doesn't need any particular builder setup.

To update one system only, pass it with `--system`:

```sh
pnpm update:conformance-oracle --system x86_64-linux
```

CI uses this form, with one job for each of the four systems. Each job
regenerates its system's table before running the suite. If the committed files
are out of date, the job runs `git diff --exit-code`, which prints the
differences in the job log so that you can apply them by hand.

Review the regenerated files and commit them together with `flake.lock`. If a
nixpkgs update leaves the Nix version and its setting information unchanged,
none of the generated files change.

After updating the pin, look at every conformance failure before changing a test
or our client. A failure might mean that the new version of Nix behaves
differently from the old one.

## How tests compare results

Each test uses one of two kinds of comparison.

A **directional** test only compares whether each client accepts or rejects an
input. Our client must reject everything that the oracle rejects, but it may
also reject other inputs. We aim to be as strict as the latest development
version of Nix, and the pinned oracle may be older. So the oracle sets the
minimum level of checking, not the exact result.

An **exact** test compares complete values. They cover the fields that both
clients parse from an input that both accept, and the settings that both resolve
from the same configuration.

## Configuration

`discoverNixStoreConfig` reads `nix.conf`, `NIX_CONFIG` and the rest of the
environment. It works out the settings that control where paths are downloaded
from, where builds run, how downloads behave, and which signatures to trust. The
suite compares these results with the output of `nix config show --json`, using
the same environment and fixture configuration.

Nix reports settings with its own names, units and structures. The adapter table
in `tests/conformance/configuration.ts` maps each of them to a field in our
client's configuration. Each entry gives our field, the Nix settings that it
comes from, and any conversion. Most mappings are direct. These are the
exceptions:

- `stalledTransferTimeoutMs` is in milliseconds, but Nix's
  `stalled-download-timeout` is in seconds.
- `building.systems` combines `system` and `extra-platforms`, because a build
  can run on any system listed in either setting.
- `builders` contains parsed entries. When the setting refers to a machines file
  with `@`, the adapter reads that file, in the same way that Nix does when it
  sends a build to a builder.
- Nix reports settings that are sets in sorted order, so the comparison sorts
  both sides first. `substituters` isn't sorted, because Nix tries substituters
  in the order that they're listed in.

### Settings that the client doesn't model

Our client only models the settings that cupboard needs, so it doesn't cover
every Nix setting in these four areas. One test lists the settings that our
client leaves out, and compares the whole list. That test fails when our client
starts modelling a setting, or when a setting disappears from Nix, so that
someone updates the list.

Another test checks that every setting in the generated table still exists in
the oracle. This catches settings that Nix has renamed.

Newer versions of Nix have renamed the settings for retrying downloads. Our
client already supports the new names, but the pinned oracle doesn't have them
yet. A third test checks that the oracle still doesn't have them. When a newer
oracle adds them, this test fails until the adapter is updated.

## Reading narinfo files from a substituter

Our substituter client must reject every narinfo that libstore rejects.
Otherwise, it could report that a path is available when Nix would then refuse
to download it.

Each test writes a narinfo and a `nix-cache-info` file to a directory, and uses
the directory as a `file://` cache. It then asks both clients for the path that
the narinfo describes.

The fixture uses a directory instead of an HTTP server because Nix caches
narinfos from HTTP substituters on disk. With an HTTP fixture, a test could get
a narinfo cached from an earlier test, until the cache entry expired. Nix
doesn't cache narinfos from a `file://` store, so each test reads the narinfo
that it wrote.

The Nix side of each test runs:

```sh
nix path-info --store file://<dir> --json --json-format 1 <path>
```

The command specifies `--json-format 1` so that a later JSON format can't change
what a field means without an error. There are three possible results:

- If Nix accepts the narinfo, it prints a JSON object and exits with status 0.
- If the cache doesn't have the path, Nix prints a null entry and exits with
  status 0.
- If Nix rejects the narinfo, it exits with a non-zero status and prints the
  reason to standard error.

Our client reports the same three results. When it rejects a narinfo, it returns
`SubstituterAnswerUnreadableError`, because the query turns `fallback` off.

Accepting or rejecting a narinfo is a **directional** comparison. Our client
must reject every narinfo that Nix rejects, but it may reject others too. When a
test fails, it adds Nix's reason to the test output. The test compares the exit
status, not the text of the message.

When both clients accept a narinfo, the suite compares everything that the
narinfo describes: the NAR hash, NAR size, download size, references, deriver
and signatures. The adapter smooths over two differences:

- Nix reports NAR hashes in SRI form, so our hash object is converted to SRI
  before comparing.
- When a narinfo has no `FileSize`, Nix leaves out the download size, and our
  client reports zero.

## Planning what a store needs

Planning a build uses three operations:

- listing which paths the substituters have;
- splitting a set of targets into paths to build and paths to download;
- deciding whether a consumer can get a whole closure from a cache.

The suite compares our client with Nix for each of them.

The fixture builds a small closure in the machine's store, creates a signing
key, and copies the signed closure to a `file://` cache. Each test then fetches
the closure into a new `local?root=` store, so it can't reuse paths that an
earlier test downloaded. These stores can download from substituters without a
daemon.

The root of the closure is an input-addressed build output, not a path created
with `builtins.toFile`. This matters because Nix accepts a content-addressed
path whatever its signature: the path's name already depends on its contents. A
fixture made only of content-addressed paths would pass even with the wrong
signing key. With an input-addressed root, both clients must check the
signature.

Each operation has its own Nix command to compare against:

- Listing available paths is compared with `nix path-info --store file://<dir>`.
  The cache advertises `WantMassQuery`, as a published cache does, so Nix sends
  the kind of batch query that the test is checking.
- Splitting into builds and downloads is compared with
  `nix-store --realise --dry-run` for the same targets and store.
- Whether a closure can be fetched is compared with a real
  `nix-store --realise`, with `require-sigs` turned on. The test uses the actual
  result of the download as the expected answer, instead of another prediction.

### Parsing the dry-run output

A dry run prints its plan to standard error, and exits with status 0 whatever
the plan is. Nix doesn't offer this information in a structured format, so this
is the only part of the suite that parses a message from Nix. The parser finds
the three headings by words that only appear in each one, accepts both singular
and plural forms, and reads the indented paths under each heading. It ignores
the download and unpacked sizes in the headings.

## Choosing a store

`nix config show` reports the `store` setting as it was written.
`nix store info` reports the store that Nix actually resolved it to.
`resolveStoreBackend` does the same resolution in our client, so the suite
compares its result with `nix store info` in the same environment.

Nix prints the resolved store URL before it tries to connect. So even when no
daemon is listening on the configured socket, the output still shows which store
Nix chose. These tests compare the URL and ignore the exit status, because they
test how the store is chosen, not whether Nix can connect to it.

Both clients report which kind of store they chose, but Nix only includes store
directories in the URL when the URI itself contains them. If the directories
come from the environment, Nix still prints a plain `local` URL. Nix prints the
default daemon socket as `daemon`, and any other daemon socket as a `unix://`
URL. Our client treats both as a daemon store.

One test sets no overrides at all, and lets the machine's filesystem and daemon
decide which store to use. This compares how the two clients choose a store in
the real environment where the suite runs.

### The per-user fallback store

On Linux, if a machine has no Nix directories and nothing else specifies a
store, Nix can create a store in the user's home directory. A machine with a Nix
state directory already has an installation. Nix uses that installation, and
doesn't create the fallback store.

Every machine that can run the suite has Nix installed, so this test always
reports itself as skipped, along with the reason. Unit tests cover this code.

## Keeping tests isolated

Each test must see only its own fixture. Every Nix command runs under
`isolatedEnvironment`, from `tests/support/nix.ts`. It gives Nix an empty system
`nix.conf`, through a temporary `NIX_CONF_DIR`, and sets `NIX_USER_CONF_FILES`
to `/dev/null`. Fixtures use temporary directories from
`tests/support/filesystem.ts`, which deletes them at the end of each test.

The only Nix command that uses the machine's normal environment is the flake
build that finds the oracle. It needs the machine's substituters to download the
oracle.

## Known limitations

- Finding the oracle evaluates the flake in the working tree. If you have
  uncommitted changes, Nix warns that the tree is dirty, which does no harm. The
  first build of the oracle in a session can take a while.
- `nix config show` doesn't say what each setting is for. So
  `tests/conformance/configuration.ts` sorts settings into the four
  configuration areas by hand. When Nix adds a relevant setting, whoever updates
  the oracle must add it to the right area.
- The adapter reads the `@file` form of the `builders` setting with the same
  rules for machines files as our client. If those rules were wrong, both sides
  would agree on the wrong answer and the test would still pass.
- `nix config show` needs the `nix-command` experimental feature. The isolated
  configuration doesn't turn it on, so the oracle command turns it on itself.
  This sets `experimental-features` only on the Nix side. None of the compared
  fields depend on that setting.
- `nix path-info` rejects a narinfo when it can't decode one of the narinfo's
  signatures, even though the narinfo parser on its own would accept that
  narinfo. The tests compare the full narinfo lookup, because that's what our
  substituter client does.
- The dry-run tests parse Nix's human-readable output. If Nix renames a heading,
  the parser finds no paths and the test fails, but the failure doesn't point at
  the cause.
- The fixture for available paths builds in the machine's own store, because
  that's the only store that can build on every platform. It leaves a few
  ordinary paths there, which garbage collection can remove. The end-to-end
  tests do the same.
- Nix doesn't require a trusted signature for a content-addressed path, but our
  client does. `offer-acceptance.ts` documents this difference, which is
  deliberate. The closure tests use an input-addressed root, so they don't
  depend on it.
- The per-user fallback store can't be tested on a machine that has Nix
  installed, and every machine that runs the suite has Nix installed. Its test
  is always skipped, and only unit tests cover that code.

[`packages/nix/src/nix-systems.json`]: ../../packages/nix/src/nix-systems.json
[`tests/conformance/oracle.json`]: ../../tests/conformance/oracle.json
