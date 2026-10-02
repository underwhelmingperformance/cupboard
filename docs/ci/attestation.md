# Attestations

Cupboard's GitHub Actions can sign build provenance for store paths whose builds
they observed on the runner. The statement identifies the repository, commit and
workflow that built the path. It is signed with [Sigstore] and attached to the
path in the destination cache. Anyone who downloads the path can verify the
statement before trusting the path. The same signing also covers an attribute
report, described below.

[Sigstore]: https://www.sigstore.dev/

The signed file is a **Sigstore bundle**, which contains an authenticated
in-toto Statement and its verification material. This differs from an [in-toto
Bundle], a JSON Lines collection of independently authenticated attestations.
Sigstore's single-signature format also differs from the [in-toto Envelope]
requirement to support multiple signatures; cupboard does not claim ITE-5
conformance for that container.

This page explains what the attestations contain, how signing fits into a
publishing run, how to keep a private cache's attestations private, and how to
verify a bundle.

[in-toto Bundle]:
  https://github.com/in-toto/attestation/blob/main/spec/v1/bundle.md
[in-toto Envelope]:
  https://github.com/in-toto/attestation/blob/main/spec/v1/envelope.md

## Discover stored evidence

Use `cupboard attest status` to inspect stored attestation metadata for several
published paths:

```sh
cupboard attest status https://cupboard.example.workers.dev/t/acme \
  --paths-file published-paths.txt \
  --predicate-type https://slsa.dev/provenance/v1
```

The report distinguishes covered paths, published paths without matching
evidence, and missing published paths. Omit `--predicate-type` to include every
type, or repeat the option to match any of the exact predicate URIs. Use
`--output-mode json` for structured results. Private caches accept the read
credential options, a configured Nix netrc, or `--github-oidc` in GitHub
Actions. OIDC credentials renew while discovery runs, and the temporary
credential files are removed when the check ends.

A successful status check exits zero even when some paths have no evidence. Pass
`--require-all` to exit one when any requested path lacks matching evidence.
Invalid arguments exit two, a scope change during discovery exits 69, temporary
service failures exit 75, and authentication refusals exit 77.

Current servers support pages of up to 32 paths. The client uses bounded
individual list reads when an older server does not advertise batch discovery.
Authentication and storage failures fail the status check.

Both publication workflows report coverage after publication and attachment,
including when signing is disabled or produces no bundles. The report compares
stored bundle digests with the manifest from the signing step. It lists paths
with fresh bundles separately from paths with other stored evidence. A path can
appear in both groups when the cache contains both kinds of evidence. All paths
in the receipt are checked, including older receipts with build subjects for
only some paths. The report compares the current NAR hash with the receipt's
expected hash wherever a subject records that hash.

Discovery reports stored descriptors. Use `attest verify` to check the bundle's
signature, signer, issuer, predicate and NAR subject. Stored evidence does not
change build selection or suppress provenance for a fresh local rebuild.

## How a bundle refers to a store path

Each attestation lists its **subjects**: the things that it makes claims about.
A subject has a name and a digest. For a store path, the name is the path's
basename (for example `0c4z5k0bc0sij5z1c2m1f3xk9d5wdp7a-hello-2.12`), and the
digest is the path's **NAR hash** in hexadecimal. The NAR hash is the hash of
the path's contents as Nix serialises them, and it's also recorded in the path's
narinfo.

The CLI matches each subject's SHA-256 digest against the selected published
paths' NAR hashes before uploading a bundle. Subject names are optional and do
not determine artifact identity. A bundle can apply to multiple selected store
paths with identical NAR bytes. This means you can't attach an attestation made
by `actions/attest-build-provenance` with its default settings. That action
attests a file's own digest, which is not the NAR hash of any store path.

## Build provenance

Build provenance is a [SLSA v1] statement about paths whose builds the run
observed. It records:

- the repository, ref and commit;
- the event that triggered the run, and the workflow file that it started;
- the workflow that ran the job. When you use one of cupboard's reusable
  workflows, this is cupboard's workflow, not yours;
- whether the runner was GitHub-hosted or self-hosted;
- a link to the run.

Its predicate type is `https://slsa.dev/provenance/v1`.

Reusing or substituting an output does not create a new build claim. Builds on a
delegated builder or a selected remote store do not provide runner-local SLSA
provenance. Existing bundles can be inherited when the destination publishes the
same store path and NAR, as described below.

[SLSA v1]: https://slsa.dev/provenance/v1

## Attribute report

With `attest: true`, a successful locally observed verification rebuild also
produces a [SCAI] attribute report. Its predicate type is
`https://in-toto.io/attestation/scai/v0.3`. The report asserts `REPRODUCIBLE`:
Nix re-executed the recorded derivation on the runner and confirmed that the
result matched the accepted output's NAR hash. The assertion's `conditions`
records the derivation. This describes that verification procedure, not
reproducibility across every environment. SCAI uses the same attribute spelling
in an example, but leaves attribute meanings and condition formats to producers
and consumers.

For a single-subject report, the assertion applies to the statement subject and
omits the optional `target`. A multi-subject report uses targets to identify the
outputs of particular derivations. The action partitions generated assertions
with their subjects to fit the subject and bundle-size limits.

Reuse preserves existing signed attestations without creating a new property
claim or collection report. A consumer verifies each original bundle's
signature, signer and predicate independently.

The action's internal `attest-sign` command also accepts supplied SCAI
predicates. Statement subjects come from the selected checksums, not from
assertion targets. SCAI permits a target to identify another resource, such as a
dependency, and permits omitted targets, URI-only descriptors, an optional
artifact producer and extension fields. Supplied fields are preserved when
signing. A multi-subject supplied report must use `run` grouping and fit one
bundle because the signer cannot infer how arbitrary assertions apply to subject
subsets. A single-subject report can be partitioned into non-empty assertion
lists without changing its subjects or evidence. Use `--receipt-file` to
generate reproduction reports with known assertion associations, or
`--predicate-file` and `--predicate-type` to sign a supplied report.

[SCAI]: https://github.com/in-toto/attestation/blob/main/spec/predicates/scai.md

## How signing fits into a run

1. The build step writes a **receipt**, which records how the requested outputs
   became available.
2. The run publishes the paths.
3. `actions/attest` checks the destination cache's narinfo for each subject
   recorded in the receipt. If a subject is missing, or its NAR hash or recorded
   deriver doesn't match the receipt, the step fails. Otherwise, the step signs
   build provenance for builds observed on the runner and an attribute report
   recording successful local verification rebuilds. The reusable workflows
   enable this with `attest: true`, which is the default.
4. `actions/attest-attach` attaches the bundles to the paths in the cache.

When the server supports grouped attachment, the CLI uploads each distinct
bundle once and sends the matching paths to the server in pages. The server
checks each path's current NAR hash and committed generation before recording
its reference to the bundle. The same procedure applies to public and private
caches, including named caches. Large public statements therefore do not require
a separate bundle upload for each subject.

With an older server, the CLI uses the per-path attachment API and uploads the
same signed bundle for each path. The fallback preserves every subject and
signature.

An active grouped attachment session renews its expiry as it processes paths.
Later pages can still attach the bundle if the cache has retired an earlier
path. The server removes staging bytes when the session expires, and R2 also
removes staging objects a day after upload. If both staging and CAS bytes are
gone, the CLI starts a new session and uploads the bundle again before retrying
the page.

The run signs after it publishes. Signing or attachment can fail after the paths
become available in the cache; the workflow then fails. Publication and
attestation attachment are separate operations.

To sign, the action requests a certificate from Fulcio, and contacts a timestamp
authority, Rekor, or both. The Sigstore client sends each of these requests up
to four times while it gets no response, or gets a 408 or 429 status or any 5xx
status. If a request still fails with no response, or with a 408, 429, 500, 502,
503 or 504 status, the action signs the statement again from the beginning, up
to four attempts for each statement. It doesn't try again when it can't read the
job's OIDC token, when Fulcio refuses to issue a certificate, or when the signed
bundle fails the action's own check.

If attachment fails, retained bundle files can be passed to
`actions/attest-attach` again. For a manual retry, `cupboard attest attach`
accepts `--bundle` for each bundle file or `--bundles-file` for the manifest
produced by `actions/attest`. The existing `--attestation` and
`--attestations-file` options are equivalent. `cupboard push` also accepts
`--bundle` and `--attestation`. Repeated bundle options append files in argument
order. The manifest options accept one path; supplying different paths fails
with usage status 2 before authentication.

`cupboard attest attach` also accepts `--paths-file` with one store path or
local link per line. File entries are always path payload, so they cannot select
a cache. Invalid path entries report the file and line number. Before acquiring
credentials, the command validates file entries and unambiguous positional
paths, and reads and parses bundle files. The first positional argument can also
select a named cache. Resolving an ambiguous cache argument requires
authentication. Invalid or unreadable input files exit with usage status 2.

A rerun that reuses an output does not recreate build provenance for the earlier
attempt. Set `build: rebuild` when the new run must execute each requested
builder again and produce fresh build evidence. Nix may still substitute
dependencies, and delegated builders or selected remote stores do not produce
runner-local SLSA provenance.

## Attestations of reused paths

When a cache publishes a path, for example by reference from another cache in
the tenant, it can inherit attestations for the same store path and NAR:

- from any public cache in the tenant that serves the path with that NAR;
- from the cache's own earlier copy of the path, when that copy had the same
  NAR.

Bundles in another private cache stay in that cache, even if the destination
later becomes public. Inheritance runs after publication. While a destination
publication or inheritance is pending, cupboard keeps eligible source
attestation references so the destination can inherit them. If the source bundle
was already unavailable when publication began, the destination cannot inherit
it. A transient failure leaves inheritance queued for another attempt. A quota
refusal removes the pending item.

The destination creates its own CAS reference and attestation list for the
committed path. Both refer to the original bundle bytes and signature. The
inheritance process does not re-sign the source statement as a claim about the
current run. The destination reference protects the bundle while the destination
path remains retained.

The cache's attestation list provides discovery, not trust. A listed digest
identifies the stored bundle bytes. Verify those bytes and their signature, then
evaluate the authenticated statement's predicate type and contents. The list's
predicate-type metadata does not replace that verification.

## Signing profiles

Three inputs of `actions/attest` control what goes into a bundle and where
records of it are published:

| Input              | Default for a public cache | Default for a private cache |
| ------------------ | -------------------------- | --------------------------- |
| `signing-profile`  | `sigstore-default`         | `tsa-only`                  |
| `upload-to-github` | `true`                     | `false`                     |
| `subject-grouping` | `run`                      | `individual`                |

If you don't set them, the action chooses the defaults by checking whether the
destination cache is public. It requests the cache's `nix-cache-info` without
credentials. A 200 response means the cache is public, and a 401 response means
it's private. Any other response fails the step.

`signing-profile` chooses how the bundle is signed:

- `sigstore-default` uses the Sigstore instance that GitHub chooses for the
  repository. For a public repository, that is the public-good instance, and the
  signature is recorded in Rekor, Sigstore's public transparency log. For a
  private repository, it's GitHub's own instance, which adds a timestamp and
  doesn't use Rekor.
- `tsa-only` signs with the public-good Sigstore instance and adds an RFC 3161
  timestamp. It doesn't write a Rekor entry.
- `rekor-and-tsa` signs with the public-good Sigstore instance, adds a
  timestamp, and writes a Rekor entry.

`upload-to-github` also stores each bundle in the repository's attestation store
on GitHub, where `gh attestation verify` can find it. The job needs the
`attestations: write` permission to upload a bundle. The permission doesn't
upload anything by itself: `upload-to-github` decides whether the action
uploads.

`subject-grouping` chooses how many paths each attestation covers. With `run`,
the action signs one attestation for each batch of up to 1,024 of the run's
paths. With `individual`, each path gets its own attestation.

Before it signs anything, the action prints which services it may contact and
where it may publish records. For `tsa-only` and `rekor-and-tsa` bundles, it
then checks each bundle's timestamp or log entry, signature, predicate type and
subjects before writing the bundle.

By default, each action invocation writes subject files in a unique directory
under `$RUNNER_TEMP/cupboard-attestations/`. Each signing step writes its
bundles, signed checksums and `bundles.txt` manifest in a separate unique
directory under `$RUNNER_TEMP/`, including when explicit subject files share a
directory. `bundles-file` returns the manifest path and lists all bundle files,
one per line. Pass `bundles-file` to `actions/attest-attach`, and run that step
only when `bundles-file` is not empty. [Writing your own publishing
job][custom-jobs] shows the steps.

[custom-jobs]: ./custom-jobs.md

Set `inline-bundles: false` when attachment uses the manifest. The default is
`true`, which also returns complete inline lists of bundle files, one per line:

- `bundle-path` lists the build-provenance bundles. It's empty when the job
  built none of the accepted paths in the receipt.
- `origin-bundle-path` lists the attribute-report bundles. It's empty when the
  report has no assertions. The action signs no build-origin statement.
- `bundles` lists all generated bundles.

`built-checksums-file` and `built-subject-count` describe accepted receipt paths
whose builds the job observed. `subject-count` counts all accepted receipt
paths. `checksums-file` lists the paths selected for signing and attachment.
Pass that file with the bundle manifest to `actions/attest-attach`.

## Private caches

The defaults for a private cache keep its attestations out of public records.
Each bundle covers a single path, has a timestamp instead of a Rekor entry, and
is stored in the cache instead of being uploaded to GitHub.

Some information still becomes public. Sigstore records every signing
certificate in a public certificate transparency log. The certificate identifies
the workflow that signed, but not the paths.

The subjects themselves are also sensitive. A subject contains a path's NAR
hash. Knowing a NAR hash doesn't let anyone download the path from a private
cache. It does reveal that the path exists, and anyone who has a copy of the
path from somewhere else can recognise it.

So think of each change to the defaults as a decision about what to disclose:

- With `upload-to-github: true`, anyone who can read the repository can read
  every bundle. You can't take back copies that people have already downloaded.
- With `rekor-and-tsa`, every bundle gets a permanent, public Rekor entry. The
  entry contains the signature, the certificate and the digest of the statement,
  not the statement itself. However, Rekor indexes the subject digests, so
  anyone who knows a NAR hash can find the entry.
- With `subject-grouping: run`, each bundle lists up to 1,024 of the run's paths
  in one statement. Anyone who has the bundle for one path learns about the
  others in the same bundle.

## Verifying a bundle

`cupboard attest verify` checks a bundle against a Sigstore trust root. You can
give it a bundle file, or ask it to fetch the bundles that a cache has for a
path.

The command needs three things to check against:

- the predicate type that you expect;
- the identity that signed the bundle, with `--certificate-identity` or
  `--certificate-identity-regex`;
- the issuer of that identity, with `--certificate-oidc-issuer` or
  `--certificate-oidc-issuer-regex`.

Pass exactly one identity option and one issuer option. Missing or conflicting
options and invalid regular expressions exit with usage status 2 before the
command reads a bundle or cache content. Remote verification also requires
exactly one of `--trusted-public-key` or `--trust-cache-pubkey`; a missing or
conflicting narinfo trust source exits with status 2 before any cache request.

For bundles signed in GitHub Actions, the issuer is
`https://token.actions.githubusercontent.com`. The identity is the workflow that
ran the job. For cupboard's reusable workflows, that's cupboard's workflow, not
the one in your repository:

```sh
identity='https://github.com/underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/vX.Y.Z'
issuer=https://token.actions.githubusercontent.com
```

This identity doesn't include your repository, so it would also match a run from
any other repository that uses the same workflow. Check the "Source repo" row in
the command's output, or apply your own stricter policy.

To verify a bundle file, pass the NAR hash that the bundle should cover. Use the
`sha256:` form from the narinfo, which `nix-store --query --hash <path>` also
prints:

```sh
cupboard attest verify ./bundle.sigstore.json \
  --nar-hash sha256:... \
  --predicate-type https://slsa.dev/provenance/v1 \
  --certificate-identity "$identity" --certificate-oidc-issuer "$issuer"
```

To verify the bundles in a cache, pass the store path's hash, and a public key
to check the narinfo's signature with:

```sh
cupboard attest verify \
  --url https://cupboard.example.workers.dev/t/acme \
  --store-path-hash 0c4z5k0bc0sij5z1c2m1f3xk9d5wdp7a \
  --trusted-public-key cupboard-acme-1:... \
  --predicate-type https://slsa.dev/provenance/v1 \
  --certificate-identity "$identity" --certificate-oidc-issuer "$issuer"
```

A few options change how the command reads from the cache:

- `--trust-cache-pubkey` downloads the public key from the cache instead of
  taking it from `--trusted-public-key`.
- For a private cache, pass `--read-user` and `--read-password`.
- If the cache has more than one bundle of the same predicate type for the path,
  for example after a rerun, choose one with `--bundle-digest`.

### Bundles without a Rekor entry

Pass `--tlog-threshold 0` to verify a bundle that has no Rekor entry. This
applies to two kinds of bundle:

- `tsa-only` bundles. These verify against the public-good trust root, which the
  command downloads by default.
- `sigstore-default` bundles from a repository that isn't public. GitHub's own
  Sigstore instance signs these, so they need GitHub's trust root. Save the
  output of `gh attestation trusted-root` to a file and pass it with
  `--trusted-root`. The file can contain one trusted root or several, one per
  line. The bundle is valid if it verifies against any of them.

A bundle from GitHub's instance also has no signed certificate timestamp, and
GitHub's trust root lists no certificate-transparency log. Pass
`--ctlog-threshold 0` as well:

```sh
gh attestation trusted-root > github-trusted-roots.jsonl
cupboard attest verify ./bundle.sigstore.json \
  --nar-hash sha256:... \
  --predicate-type https://slsa.dev/provenance/v1 \
  --certificate-identity "$identity" --certificate-oidc-issuer "$issuer" \
  --trusted-root github-trusted-roots.jsonl \
  --tlog-threshold 0 --ctlog-threshold 0
```

`--ctlog-threshold 0` only applies to a trusted root that lists no
certificate-transparency log. The command refuses it without `--trusted-root`,
because the public-good root lists one, and it refuses it when every root in the
file lists one. The command always requires a verified signed timestamp.

### Verifying with `gh`

If a bundle was uploaded to GitHub, you can also verify it with
`gh attestation verify`. Give it the path's NAR, which `nix-store --dump`
produces, and use `--signer-workflow` to specify cupboard's workflow.
