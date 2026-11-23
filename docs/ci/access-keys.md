# Publishing without OIDC

A GitHub Actions job publishes with its OIDC identity token, and a trust rule
decides what the token allows. The job stores no cupboard secret. Use that
whenever you can; the [quickstart](./quickstart.md) sets it up.

A CI system that can't give cupboard an OIDC token can publish with an access
key instead. An access key is a long-lived secret, so anyone who copies it can
publish what it allows until it expires or you delete it. Give it the fewest
grants and the shortest expiry that the job can work with.

## Creating a key for the job

Create a key with the grants that the job needs. This one can push to the
default cache and set roots under `ci/acme-app/main/`, and it expires after 90
days:

```sh
cupboard access-key create https://cupboard.example.workers.dev/t/acme \
  --allow push --allow root --root ci/acme-app/main/ --expires-in 90d
```

The options work as they do for [trust rules](./trust-rules.md). Add
`--cache <name>` for a named cache, `--allow attest` to attach attestations, and
`--allow read` if the job also reads a private cache. Only a credential with
`access-key:create` for those grants can create a key that lasts longer than the
credential itself; see [Access keys](../admin/access.md#access-keys).

Store the printed key in your CI system's secret store.

## Publishing with the key

Pass the key to `cupboard push` in the `CUPBOARD_ACCESS_KEY` environment
variable. The CLI then uses the key, and the job needs neither a login session
nor an OIDC token:

```sh
export CUPBOARD_ACCESS_KEY="$CUPBOARD_ACCESS_KEY_SECRET"
cupboard push https://cupboard.example.workers.dev/t/acme \
  --closure --root ci/acme-app/main/app --ttl 30d ./result
```

The `--access-key` option takes the same value, but a value on the command line
can be visible to other processes on the machine. The variable keeps it out of
the process list.

`cupboard plan cohort`, `cupboard attest attach` and `cupboard attest status`
accept the same option and variable. A key for a private reuse view or reference
source goes in `--view-access-key` or `CUPBOARD_VIEW_ACCESS_KEY`.

## Replacing and revoking the key

To replace the key, create a new one, update the secret, then delete the old key
with `cupboard access-key delete`. Deleting a key also deletes every key that it
created. The read routes can still accept a deleted key for up to five minutes,
and work that the key started before the deletion, such as an open commit
session, can continue for up to 15 minutes.

If the key leaks, delete it straight away.

A key created from your sign-in session belongs to that session. Signing out, an
expired session and a replayed refresh token end the session but keep a key
created with `access-key:create`. `cupboard session revoke` deletes every key
below the session. If the session may have been stolen, find it, revoke it and
check the keys that remain:

```sh
cupboard session list https://cupboard.example.workers.dev/t/acme
cupboard session revoke https://cupboard.example.workers.dev/t/acme <id>
cupboard access-key list https://cupboard.example.workers.dev/t/acme
```

The setup action also reads a job-level `CUPBOARD_ACCESS_KEY`, and then reads
private caches with the key instead of the job's OIDC token. If the job sets the
variable for every step, give the key `--allow read` for the caches that the job
reads, and don't pass `read-caches` to setup.
