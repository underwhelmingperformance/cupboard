# Using Cupboard as a nixbuild.net cache

[nixbuild.net] can upload the results of every build to an external cache, so a
closure is pushed straight from the builder rather than pulled down to CI and
pushed again. It supports two upload targets: a Cachix cache, or an
S3-compatible service. Cupboard exposes an S3-compatible endpoint, so
nixbuild.net can push directly into a tenant's cache.

This page covers configuring the endpoint, provisioning a credential, and
pointing nixbuild.net at it. `nix copy` and other S3 clients can use the same
credentials and URL shape when they use Cupboard's [supported operations and
payload modes].

[nixbuild.net]: https://docs.nixbuild.net/settings/
[supported operations and payload modes]: ./s3.md

## How it works

The endpoint speaks the AWS S3 protocol with SigV4 authentication. It is not a
general object store. Each tenant has one bucket. The default cache occupies the
bucket root, while each named cache uses an object-key prefix. The only writable
objects are narinfo files and NARs, and a listing shows `nix-cache-info`,
`*.narinfo` and `nar/*`. Reads of stored objects are served straight from R2;
writes use Cupboard's existing verification, signing and commit pipeline.

Cupboard stages each NAR upload. When the corresponding narinfo arrives,
Cupboard decompresses the NAR, verifies its hash against the narinfo, and signs
the narinfo with the tenant's key. The narinfo PUT returns success only after
the path is servable, which gives clients read-after-write consistency.

## Deployment configuration

The endpoint is enabled by two Worker settings:

- `S3_HOST`: the hostname that receives S3 requests, for example
  `s3.cupboard.example.com`. Every request on this host is treated as an S3
  operation. Point a route at it in `wrangler.jsonc` and set the variable to the
  same hostname. The endpoint refuses plaintext requests unless
  `CUPBOARD_LOCAL_DEV` explicitly enables local development. When `S3_HOST` is
  unset the endpoint is inert.
- `S3_SECRET_KEY`: one or more comma-separated base64-encoded 256-bit keys used
  to encrypt stored credential secrets at rest. Set it as a Worker secret. The
  first key encrypts new secrets. The remaining keys decrypt credentials created
  before a rotation. To rotate the key, put the new key first and retain each
  old key until the credentials encrypted with it have been re-issued. Removing
  a key prevents those credentials from authenticating. When the value is unset
  or empty the endpoint answers `501 Not Implemented`.

Cupboard's garbage collection removes staging objects left by interrupted
single-part uploads. It also aborts incomplete multipart uploads and releases
their quota reservations after six days. R2's [default seven-day automatic
abort][r2-multipart-lifecycle] is the backstop. If R2 has already removed the
upload handle, Cupboard deletes any completed object left at the staging key
before it releases the reservation.

[r2-multipart-lifecycle]:
  https://developers.cloudflare.com/r2/objects/upload-objects/

## Provisioning a credential

An S3 credential is scoped to one cache and consists of an access key ID and a
secret access key. Because SigV4 uses symmetric keys, the server must retain the
secret so it can verify requests. Cupboard encrypts the secret with AES-GCM
under `S3_SECRET_KEY` and returns it in plaintext only when the credential is
created.

Provision a credential with the CLI, passing `--endpoint` so it also prints the
nixbuild.net settings ready to paste:

```console
$ cupboard s3-credential create https://cache.example.workers.dev/t/acme \
    --label nixbuild --endpoint https://s3.cupboard.example.com
```

The secret access key is shown only once. Pass `--cache <name>` to scope the
credential to a named cache, `--read-only` for a substitute-only credential, and
`--expires-at <iso>` to give it a lifetime. `cupboard s3-credential list` shows
the credentials a cache holds, and
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
`secret-key` setting unset. Cupboard signs each narinfo with the tenant's key
when it commits the path, so nixbuild.net does not need its own signing key.

## Signatures and trust

Cupboard signs every narinfo it serves with the tenant's signing key, whether
the path arrived through this endpoint or the CLI. Consumers keep trusting the
one key published at the cache's `/pubkey`; nothing about the trust
configuration changes when a path is pushed by nixbuild.net rather than CI.

## Provenance

A direct push does not produce the current-run build receipt that the `attest`
action requires. The action therefore cannot attest paths that nixbuild.net
pushed on its own. Requiring the receipt prevents a CI job from claiming
provenance for bytes it did not build. A signed narinfo proves that Cupboard
accepted the path, not who built it.

If a workflow requires SLSA provenance, use `actions/build-paths` or
`actions/build-cohort` to produce a current-run receipt, publish the receipt's
paths, and pass the receipt to `actions/attest`. A direct S3 push has no build
receipt, but Cupboard still records the credential used for the narinfo PUT that
committed the path.

## Auditing a push

Cupboard records the ID and label of the S3 credential used for the narinfo PUT
that committed a path. This identifies the commit request. It does not prove
that the same credential uploaded the NAR. `cupboard inspect <url> <store-path>`
shows this record in the `Origin` field. A path pushed through the native API
reports a native push. Callers that may read the narinfo but may not list S3
credentials see that the path came through S3, but the credential details are
hidden. This administrative record never appears in the narinfo served to
consumers.

## Supported S3 operations

The endpoint supports the read and listing operations used by generic S3
clients, plus the writes required by the Nix cache protocol:

- Reads: `GetObject` (with `Range`), `HeadObject`, `HeadBucket`,
  `GetBucketLocation`, `ListObjects`, and `ListObjectsV2` with `prefix` and
  `delimiter`.
- Writes: `PutObject` for narinfo and NAR objects, and multipart upload for NAR
  objects.

Object deletion, `CopyObject`, and arbitrary non-cache writes are not supported.
ETags and `Last-Modified` are whatever R2 reports for stored objects; the
synthesised `nix-cache-info` carries a deterministic ETag and the cache's
creation time.
