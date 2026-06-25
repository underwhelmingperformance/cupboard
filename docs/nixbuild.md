# Using Cupboard as a nixbuild.net cache

[nixbuild.net] can upload the results of every build to an external cache, so a
closure is pushed straight from the builder rather than pulled down to CI and
pushed again. It supports two upload targets: a Cachix cache, or an
S3-compatible service. Cupboard exposes an S3-compatible endpoint, so
nixbuild.net can push directly into a tenant's cache.

This page covers configuring the endpoint, provisioning a credential, and
pointing nixbuild.net at it. The endpoint is the same one any S3 client can use,
so the credential and `s3://` URL described here also work with `nix copy`,
`aws s3`, `rclone` and similar tools.

[nixbuild.net]: https://docs.nixbuild.net/settings/

## How it works

The endpoint speaks the AWS S3 protocol with SigV4 authentication. It is not a
general object store: it presents a single tenant's cache, so the only writable
objects are narinfo files and NARs, and a listing shows `nix-cache-info`,
`*.narinfo` and `nar/*`. Reads of stored objects are served straight from R2;
writes flow through Cupboard's normal verify, sign and commit path.

A NAR upload is staged, and the narinfo upload that follows is verified before
it becomes servable: Cupboard decompresses the staged NAR, checks its hash
against the narinfo, signs the narinfo with the tenant's own key, and only then
returns success. A push therefore behaves the way `nix copy` expects, where a
path is readable as soon as its upload completes.

## Deployment configuration

The endpoint is enabled by two Worker settings:

- `S3_HOST`: the hostname the endpoint answers on, for example
  `s3.cupboard.example.com`. Every request on this host is treated as an S3
  operation. Point a route at it in `wrangler.jsonc` and set the variable to the
  same hostname. When it is unset the endpoint is inert.
- `S3_SECRET_KEY`: one or more comma-separated base64-encoded 256-bit keys used
  to encrypt stored credential secrets at rest. Set it as a Worker secret. The
  first key seals new secrets; any further keys are retained for decryption, so
  a key can be rotated out by moving it down the list and dropping it once the
  credentials sealed under it have been re-issued. A credential whose key is no
  longer present stops resolving and must be re-issued. When the value is unset
  or empty the endpoint answers `501 Not Implemented`.

The S3 staging objects an interrupted upload leaves behind are reclaimed by the
periodic sweep, but an interrupted _multipart_ upload is held by R2 itself.
Configure an "abort incomplete multipart uploads" lifecycle rule on the blob
bucket so those are reclaimed too.

## Provisioning a credential

A credential is scoped to one cache and carries an access key id and a secret
access key. SigV4 is a symmetric scheme, so unlike Cupboard's OAuth tokens the
server must hold the secret to verify a signature; it is stored
AES-GCM-encrypted under `S3_SECRET_KEY` and is shown in plaintext only once,
when it is created.

Provision a credential with the CLI, passing `--endpoint` so it also prints the
nixbuild.net settings ready to paste:

```console
$ cupboard s3-credential create https://cache.example.workers.dev/t/acme \
    --label nixbuild --endpoint https://s3.cupboard.example.com
```

The secret access key is shown only once, here. Pass `--cache <name>` to scope
the credential to a named cache, `--read-only` for a substitute-only credential,
and `--expires-at <iso>` to give it a lifetime. `cupboard s3-credential list`
shows the credentials a cache holds, and
`cupboard s3-credential revoke <access-key-id>` removes one.

## nixbuild.net settings

`cupboard s3-credential create --endpoint ...` prints these two lines for you.
They use path-style addressing so the bucket appears in the path; the bucket is
the tenant slug and an optional prefix selects a named cache (omit it for the
default cache):

```
nixbuild.net> settings caches --add s3://<tenant>/<cache>?region=auto&endpoint=https://<S3_HOST>&addressing-style=path
nixbuild.net> settings access-tokens --add s3://<tenant>/<cache>=<ACCESS_KEY_ID>:<SECRET_ACCESS_KEY>
```

nixbuild.net compresses NARs with zstd, which is Cupboard's storage format, so
the bytes are stored as received with no re-encoding. Leave the optional
`secret-key` setting unset: Cupboard signs each narinfo with the tenant's own
key on the way in (see below), so a nixbuild-side signing key is not needed.

## Signatures and trust

Cupboard signs every narinfo it serves with the tenant's signing key, whether
the path arrived through this endpoint or the CLI. Consumers keep trusting the
one key published at the cache's `/pubkey`; nothing about the trust
configuration changes when a path is pushed by nixbuild.net rather than CI.

## Provenance

A direct push does not run the GitHub Action's `attest` step, so no SLSA
provenance attestation is produced for those paths on its own. To keep
provenance, run the lightweight `attest` step from CI against the resulting
paths: the heavy NAR transfer moves to nixbuild.net while the provenance is
still attached. nixbuild.net does not emit provenance of its own, so there is
nothing else to ingest.

The attestation subject is a path's NAR hash. When the closure was built and
pushed by nixbuild.net rather than realised in CI, fetch the NAR hash from
Cupboard instead of computing it locally: it is the `NarHash` of the served
narinfo, and `cupboard inspect <url> <store-path> --output-mode json` returns it
alongside the rest of the path's summary.

## Auditing a push

Every path Cupboard accepts over the S3 endpoint records its origin: the
credential that pushed it, by id and label. This is how a direct,
attestation-less push stays auditable. `cupboard inspect <url> <store-path>`
shows it as the `Origin` field; a path pushed by the CLI instead reports a
native push. The origin is an administrative record and never appears in the
narinfo served to consumers.

## Supported S3 operations

The endpoint implements the read and list surface a generic S3 client needs,
plus the writes the Nix cache protocol requires:

- Reads: `GetObject` (with `Range`), `HeadObject`, `HeadBucket`,
  `GetBucketLocation`, and `ListObjectsV2` with `prefix` and `delimiter`.
- Writes: `PutObject` and multipart upload for narinfo and NAR objects.

Object deletion, `CopyObject`, and arbitrary non-cache writes are not supported.
ETags and `Last-Modified` are whatever R2 reports for stored objects; the
synthesised `nix-cache-info` carries a deterministic ETag and the cache's
creation time.
