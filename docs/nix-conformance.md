# The Nix conformance suite

`packages/nix` re-implements part of Nix's libstore client in TypeScript. It
discovers `nix.conf`, resolves the selected store backend, queries binary
caches, parses narinfo files, and partitions a closure into paths that are
present, substitutable, or need building. The conformance suite checks these
operations against a real `nix` client.

Each test creates one fixture, runs the same operation through our client and a
`nix` binary, and compares the results. The expected values therefore come from
Nix rather than from hand-written fixtures. A behavioural difference fails
whether it comes from our code or from a new Nix version.

## Running the suite

```sh
pnpm check:conformance
```

The suite requires a working Nix installation. CI runs it for every system in
[`packages/nix/src/nix-systems.json`].

## The oracle

The repository's flake pins the `nix` binary that the suite uses as its oracle.
The suite does not use an arbitrary binary from `PATH`. The flake exposes the
binary as the `conformanceNix` output, which the suite resolves with:

```sh
nix build .#conformanceNix --no-link --print-out-paths
```

Each test file resolves the output once and shares it across its cases. If the
machine cannot build the output, the suite fails instead of skipping the
comparison.

[`tests/conformance/oracle.json`] records the expected Nix version for each
supported system. The suite reads `builtins.currentSystem` from the resolved
binary, then selects the corresponding version and settings table. It refuses to
run a case when the flake produces a different version.

Two checks keep the record consistent:

- `pnpm check:conformance-oracle` checks that each version in the record matches
  the corresponding generated settings table. It does not run Nix.
- The conformance suite compares the resolved binary's `nix --version` output
  with the recorded version, then compares the complete generated settings table
  with the types reported by that binary and the widths inferred from accepted
  boundary values.

### The generated settings table

`pnpm update:conformance-oracle` also writes one generated settings table per
system under `packages/nix/src`. The client selects the table for its current
Node platform and architecture when it decides whether Nix would accept a
setting value. The update command derives two kinds of metadata from each pinned
Nix binary.

First, it reads the value type for each setting from `nix config show --json`.

Second, it determines the fixed C++ width of each integer setting. Nix rejects
values outside that width but does not report the width directly. The update
command tries four boundary values for each integer setting and records the
width indicated by the accepted values. This requires four `nix config show`
runs per integer setting. The oracle test performs the same probes for the
system on which it runs. A lockfile refresh changes the generated table only
when that system's pinned Nix has different setting types or integer widths.

If the accepted values do not match a known width, the update fails. This forces
the table reader to be updated when Nix adds another integer width.

### Bumping the oracle

Update the pin, then run the conformance suite:

```sh
nix flake update
pnpm check:conformance
```

If the pinned Nix version or settings table changed, regenerate the records:

```sh
pnpm update:conformance-oracle
```

The command requests a probe derivation for every supported system. Nix can
build a probe locally, substitute it, or send it to any configured builder. The
updater does not inspect the host system or require a particular builder
configuration.

To update one system, pass its name explicitly:

```sh
pnpm update:conformance-oracle --system x86_64-linux
```

CI uses this form in a four-system runner matrix. Each job regenerates its
system's table before running the suite. If the checked-in data is stale,
`git diff --exit-code` prints the patch in the job log for manual application.

Inspect and commit the regenerated files with `flake.lock`. A nixpkgs update
that leaves the selected Nix version and derived setting metadata unchanged
needs no generated file changes.

After a pin update, inspect every conformance failure before changing the test
or client. A failure may indicate that the new Nix version behaves differently
from the old one.

## What a case asserts

Each case declares one of two comparison modes.

**Directional** cases compare acceptance and rejection. Our client must reject
anything the oracle rejects, but it may reject additional inputs. The project
targets the strictness of Nix master while the pinned oracle may be older, so
the oracle provides a minimum level of validation rather than an exact result.

**Exact** cases compare complete values. They cover fields parsed from an input
that both clients accept and settings resolved from the same configuration.

## The resolved configuration

`discoverNixStoreConfig` reads `nix.conf`, `NIX_CONFIG`, and the environment. It
resolves settings for substitution sources, build locations, transfer policy,
and trusted signatures. The suite compares these results with
`nix config show --json` under the same environment and fixture configuration.

Nix reports settings with its own names, units, and data shapes. The adapter
table in `tests/conformance/configuration.ts` maps them to fields in our
resolved configuration. Each entry specifies the client field, its source Nix
settings, and any required conversion. Most mappings are direct. The exceptions
are:

- `stalledTransferTimeoutMs` is measured in milliseconds, while
  `stalled-download-timeout` is measured in seconds.
- `building.systems` combines `system` and `extra-platforms` because a build may
  run on any system in either setting.
- `builders` contains parsed entries. When the setting refers to a machines file
  with `@`, the adapter follows the indirection as Nix does when dispatching a
  build.
- Nix reports set-valued settings in sorted order, so the comparison sorts both
  sides before comparing their members. `substituters` remains ordered because
  Nix tries each substituter in that order.

### The unmodelled report

The four configuration groups do not model every Nix setting in their domains.
One case records the omitted settings in the test output and compares the whole
list. The test therefore fails when a setting becomes modelled or disappears
from Nix without a corresponding update. Another case verifies that every
setting in the generated table still exists in the oracle, which detects renamed
settings.

Our client also supports the renamed transfer retry settings introduced after
the pinned oracle. A third case verifies that the oracle still omits those
settings. When a future oracle includes the rename, the test fails until the
adapter is updated.

## Narinfo read from a substituter

Our substituter client must reject any narinfo document that libstore rejects.
Otherwise it could report a path as available even though Nix later refuses to
fetch it. Each case writes a narinfo and `nix-cache-info` to a directory,
exposes the directory as a `file://` cache, and queries the described path
through both clients.

The fixture uses a directory instead of HTTP because Nix caches narinfos from
HTTP substituters on disk. An HTTP fixture could therefore return data from a
previous case until the narinfo TTL expires. A `file://` store bypasses that
cache, so each case reads the document it created.

```sh
nix path-info --store file://<dir> --json --json-format 1 <path>
```

The command pins `--json-format 1` so a later format cannot silently change a
field's meaning. Nix produces three relevant outcomes:

- An accepted document produces a JSON object and exits zero.
- A path that is absent from the cache produces a null entry and exits zero.
- A rejected document exits non-zero and writes the reason to stderr.

Our client reports the same three outcomes. A rejected document produces
`SubstituterAnswerUnreadableError` because the query disables `fallback`.

Acceptance is **directional**: our client must reject every document that Nix
rejects, but it may reject additional documents. A failing case adds Nix's
reason as a test annotation. The assertion uses the exit status rather than the
message text.

When both clients accept a document, the suite compares the complete offer: the
NAR hash, NAR size, download size, references, deriver, and signatures. The
adapter normalises two differences. Nix reports NAR hashes in SRI form, so our
hash object renders SRI from its digest. When a narinfo omits `FileSize`, Nix
omits the download-size field while our client reports zero.

## What a store can obtain

Planning depends on three operations: listing paths offered by substituters,
partitioning a target into paths to build and fetch, and determining whether a
consumer can realise a closure from a cache. The suite compares our client with
Nix for each operation.

The fixture builds a small closure in the host store, creates a signing key, and
copies the signed closure to a `file://` cache. Each case realises the closure
into a fresh `local?root=` store, so it cannot reuse paths fetched by an earlier
case. These stores support substitution without a daemon.

The closure root is a built, input-addressed output rather than a path produced
by `builtins.toFile`. Nix accepts a content-addressed path regardless of its
signature because the store-path name commits to the contents. A fixture made
only from content-addressed paths would therefore succeed with an unrelated
signing key. The input-addressed root ensures that both clients enforce the
signature check.

Each operation has a separate oracle:

- Offered paths are compared with `nix path-info --store file://<dir>`. The
  cache advertises `WantMassQuery`, as a published cache does, so Nix sends the
  batch query being tested.
- The build and fetch partition is compared with `nix-store --realise --dry-run`
  for the same targets and store.
- The closure verdict is compared with an actual `nix-store --realise` while
  `require-sigs` is enabled. The real substitution result is the oracle rather
  than a separate prediction.

### The dry-run message

A dry run writes its plan to stderr and exits zero for every plan. Nix provides
no structured form of this result, so this is the only part of the suite that
parses a Nix message. The parser identifies the three headings from their
distinguishing words, accepts singular and plural forms, and reads the indented
paths below them. It ignores the download and unpacked sizes in the headings.

## The store selected by a configuration

`nix config show` reports the `store` setting as written, while `nix store info`
reports the resolved store. `resolveStoreBackend` performs the same resolution,
so the suite compares its result with `nix store info` under the same
environment.

Nix prints the resolved URL before attempting a connection. A configuration can
therefore reveal its selected store even when no daemon is listening at the
configured socket. These cases compare the URL and ignore the exit status
because they test store selection rather than connectivity.

Both clients expose the selected backend, but Nix includes store directories in
the URL only when the URI specifies them. Directories provided through the
environment still produce a plain `local` URL. Nix reports the usual daemon
socket as `daemon` and any other daemon socket as its `unix://` URL. Both forms
map to the daemon-store backend.

One case supplies no overrides and lets the machine select the backend from its
filesystem and daemon state. This compares automatic selection under the actual
environment in which the suite runs.

### The user fallback store

On Linux, Nix can create a per-user store when the machine has no Nix
directories and no other store is implied. A machine with a Nix state directory
already has an installation whose own directories take precedence, so Nix
disables this fallback. Every machine that can run the suite has such an
installation. The fallback case therefore reports itself as skipped, including
the condition that prevented it from running. Unit tests cover this code path.

## Isolation

Each case must see only its own fixture. Every Nix invocation runs under
`isolatedEnvironment` from `tests/support/nix.ts`, which supplies an empty
system `nix.conf` through a temporary `NIX_CONF_DIR` and points
`NIX_USER_CONF_FILES` at `/dev/null`. Fixtures use temporary directories from
`tests/support/filesystem.ts`, which removes them when the case finishes.

The flake build that resolves the oracle is the only invocation that uses the
machine's normal environment. It needs the machine's substituters to fetch the
oracle.

## Known limitations

- Resolving the oracle evaluates the flake from the working tree. Uncommitted
  changes produce a harmless dirty-tree warning, and the first resolution in a
  session may take some time.
- `tests/conformance/configuration.ts` explicitly classifies settings into the
  four configuration domains because `nix config show` does not describe each
  setting's purpose. When Nix adds a relevant setting, the oracle update must
  classify it during review.
- The adapter parses a `builders` setting's `@file` indirection using the same
  machines-file rules as our client. Both sides could therefore agree on an
  incorrect interpretation.
- `nix config show` requires the `nix-command` experimental feature. The
  isolated configuration does not enable it, so the oracle command enables it
  explicitly. This assigns `experimental-features` only on the oracle side, but
  no mapped field reads the setting.
- `nix path-info` rejects a narinfo with an undecodable signature even though
  the narinfo parser alone would accept it. The cases compare the complete
  narinfo read because that is the operation our substituter client performs.
- The dry-run cases parse Nix's human-readable plan. If Nix renames a heading,
  the parser returns no paths and the test fails without a direct mismatch
  report.
- The availability fixture builds in the host store because it is the only store
  that can build on every platform. It leaves a few ordinary,
  garbage-collectable paths there, as the end-to-end suite does.
- Our client requires a trusted signature for a content-addressed path for which
  Nix waives the requirement. `offer-acceptance.ts` documents this deliberate
  difference. The closure cases use an input-addressed root so they do not rely
  on the waiver.
- The user fallback store cannot be exercised on a machine with Nix installed,
  which includes every machine that runs the suite. Its case is always skipped,
  and unit tests provide the only coverage for that path.

[`packages/nix/src/setting-types.generated.ts`]:
  ../packages/nix/src/setting-types.generated.ts
[`packages/nix/src/nix-systems.json`]: ../packages/nix/src/nix-systems.json
[`tests/conformance/oracle.json`]: ../tests/conformance/oracle.json
