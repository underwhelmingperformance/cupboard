# Attestations

When cupboard's GitHub Actions publish a store path, they can also sign a
statement about where the path came from: which repository, commit and workflow
built it, and how. The statement is signed with
[Sigstore](https://www.sigstore.dev/) and stored in the cache next to the path.
Anyone who downloads the path can check this signed statement before trusting
the path.

The signed file is called a **bundle**, and the statement inside it is an
**attestation**. This page explains what the attestations contain, how signing
fits into a publishing run, how to keep a private cache's attestations private,
and how to verify a bundle.

## How a bundle refers to a store path

Each attestation lists its **subjects**: the things that it makes claims about.
A subject has a name and a digest. For a store path, the name is the path's
basename (for example `0c4z5k0bc0sij5z1c2m1f3xk9d5wdp7a-hello-2.12`), and the
digest is the path's **NAR hash** in hexadecimal. The NAR hash is the hash of
the path's contents as Nix serialises them, and it's also recorded in the path's
narinfo.

cupboard only attaches a bundle to a path if one of the bundle's subjects has
that path's NAR hash. This means you can't attach an attestation made by
`actions/attest-build-provenance` with its default settings. That action attests
a file's own digest, which is not the NAR hash of any store path.

## The two kinds of attestation

### Build provenance

Build provenance is a [SLSA v1](https://slsa.dev/provenance/v1) statement about
the paths that a run built. It records:

- the repository, ref and commit;
- the event that triggered the run, and the workflow file that it started;
- the workflow that ran the job. When you use one of cupboard's reusable
  workflows, this is cupboard's workflow, not yours;
- whether the runner was GitHub-hosted or self-hosted;
- a link to the run.

Its predicate type is `https://slsa.dev/provenance/v1`.

### Build origin

Build origin records how each published path became available during the run.
Only the flake publish workflow produces it, because it needs the detailed
receipt that the workflow writes (a version 3 receipt). Its predicate type is
`https://github.com/underwhelmingperformance/cupboard/predicate/build-origin/v2`.

A path can become available in four ways, and the build-origin statement records
different details for each:

- The run built the path. The statement records the derivation, the store that
  the path was built in, and how the run observed the build. If the build ran on
  a remote builder that identified itself, the statement records the builder.
- The path was already in the build store. The statement records that store, and
  says that the run didn't see the path being built.
- The path was copied into the store. The statement records the signatures and
  content address that the store reported, and every source that the run saw it
  copied from, including failed attempts.
- The path was published by reference from another cache. No files were copied
  in this case. The statement records the other cache, the NAR hash that the
  destination publishes, and the deriver, content address and signatures that
  the other cache reported. It can't say where the other cache's copy came from.

A build-origin statement doesn't claim that a path is reproducible, or that
whoever produced it is trustworthy. When the run didn't see where a copy came
from, the statement doesn't say where it came from.

## How signing fits into a run

1. The build step writes a **receipt**, which lists what the run built and what
   it will publish.
2. The run publishes the paths.
3. `actions/attest` reads the destination cache's narinfo for every path in the
   receipt. If a path is missing, or its NAR hash or deriver doesn't match the
   receipt, the step fails. Otherwise, the step signs the attestations.
4. `actions/attest-attach` attaches the bundles to the paths in the cache.

The run signs after it publishes, so a bundle only ever describes a path that
the cache has already accepted.

To sign, the action requests a certificate from Fulcio, and contacts a timestamp
authority, Rekor, or both. The Sigstore client sends each of these requests up
to four times while it gets no response, or gets a 408 or 429 status or any 5xx
status. If a request still fails with no response, or with a 408, 429, 500, 502,
503 or 504 status, the action signs the statement again from the beginning, up
to four attempts for each statement. It doesn't try again when it can't read the
job's OIDC token, when Fulcio refuses to issue a certificate, or when the signed
bundle fails the action's own check.

If signing fails, the paths have already been published, but without
attestations. Rerunning the flake publish workflow or `cupboard-publish.yml`
rebuilds the paths and signs them. A job that you've written yourself needs
`require-provenance: true` on `build-paths` to do the same. Without it, the
rerun would download the paths from the cache instead of building them, and
there would be no build to attest.

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
on GitHub, where `gh attestation verify` can find it.

`subject-grouping` chooses how many paths each attestation covers. With `run`,
one attestation covers up to 1,024 of the run's paths. With `individual`, each
path gets its own attestation.

Before it signs anything, the action prints which services it may contact and
where it may publish records. For `tsa-only` and `rekor-and-tsa` bundles, it
then checks each bundle's timestamp or log entry, signature, predicate type and
subjects before writing the bundle.

The action writes bundles to `$RUNNER_TEMP/cupboard-attestations/`. Its outputs
list the files.

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
- With `subject-grouping: run`, each bundle lists every path of the run and its
  origin. Anyone who has the bundle for one path learns about all the others.

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
- `sigstore-default` bundles from private repositories. These need GitHub's
  trust root. Save the output of `gh attestation trusted-root` to a file and
  pass it with `--trusted-root`. The file can contain one trusted root or
  several, one per line. The bundle is valid if it verifies against any of them.

### Verifying with `gh`

If a bundle was uploaded to GitHub, you can also verify it with
`gh attestation verify`. Give it the path's NAR, which `nix-store --dump`
produces, and use `--signer-workflow` to specify cupboard's workflow.
