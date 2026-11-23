### Access keys replace static read credentials

This release removes static read credentials: the tenant read credential and
every cache read credential. Private reads with a static credential start to
fail when the new Workers begin to serve requests, and keep failing until each
reader has an access key. Nix configurations, scripts and workflows that send a
static password get 401 from every private cache and reuse view in that time.
Public caches are not affected. After the upgrade, a private cache accepts only
an access key, a short-lived CI read token or an administrator's token. The
deploy's contract migration then clears the stored credentials from D1.

Access keys are new in this release, so they can't be created before the
upgrade. To keep the outage short:

1. Before you deploy, list every reader that uses a static credential, and the
   caches and reuse views that each one reads. Decide the grants and expiry of
   the key for each reader, and how you will update its netrc file, substituter
   URL or secret.
2. Deploy the release.
3. Create the keys straight away, as described below. One sign-in session can
   have at most 256 unexpired keys below it. A key created with
   `access-key:create` outlives the session: signing out, expiry and a replayed
   refresh token end the session and keep the key. After a replayed refresh
   token, the session's tokens can't create keys, but a key below the session
   can still create keys until you revoke the session. If a session may have
   been stolen, find it, revoke it, which deletes every key below the session,
   and check the keys that remain:

   ```sh
   cupboard session list https://cupboard.example.workers.dev/t/acme
   cupboard session revoke https://cupboard.example.workers.dev/t/acme <id>
   cupboard access-key list https://cupboard.example.workers.dev/t/acme
   ```

4. Update each reader with its key.

#### After you upgrade the server

A tenant administrator creates an access key for each reader. A key needs a
content-read grant for each cache or reuse view that it reads. For example, for
the default cache, the `release` cache and the `prior` reuse view:

```sh
cupboard access-key create https://cupboard.example.workers.dev/t/acme \
  --allow read --view prior --expires-in 90d
cupboard access-key create https://cupboard.example.workers.dev/t/acme \
  --allow read --cache release --expires-in 90d
```

Each command prints the key once. See [Access keys][access-keys] for grants,
expiry and deletion.

On each machine, replace the password in the netrc file with the key. The server
ignores the user name:

```
machine cupboard.example.workers.dev login cupboard password cupboard_ak_...
```

A substituter URL that contained a cache read credential takes the key in the
same way:

```
extra-substituters = https://cupboard:cupboard_ak_...@cupboard.example.workers.dev/t/acme/cache/release
```

A GitHub Actions job whose trust rule permits content reads doesn't need a key.
Remove its static read secrets.

[access-keys]: ../../admin/access.md#access-keys

#### Changed commands and options

- `cupboard tenant rotate-credential`, `clear-credential`,
  `rotate-cache-credential` and `clear-cache-credential` are removed.
  `cupboard tenant create` and `cupboard init` no longer create a tenant read
  credential, and `--read-user` and `--no-read-password` are removed.
- `--read-user` and `--read-password`, and `CUPBOARD_READ_USER` and
  `CUPBOARD_READ_PASSWORD`, are replaced by `--access-key` and
  `CUPBOARD_ACCESS_KEY` on `push`, `plan cohort`, `plan reprobe`,
  `plan dependencies`, `attest attach`, `attest verify`, `attest status`,
  `config`, `github setup` and `github check`. `build-push`, `root ensure`,
  `root list` and `root targets` also accept the key. On `push`, `build-push`,
  the `root` commands, `plan cohort`, `plan dependencies` and `attest attach`,
  the key replaces the login session or `--github-oidc`. When one of these
  commands reads the key from `CUPBOARD_ACCESS_KEY`, it prints a line on
  standard error to say so. `access-key create`, `list` and `delete` accept a
  key only from `--access-key`.
- `--view-read-user` and `--view-read-password`, and `CUPBOARD_VIEW_READ_USER`
  and `CUPBOARD_VIEW_READ_PASSWORD`, are replaced by `--view-access-key` and
  `CUPBOARD_VIEW_ACCESS_KEY`. `push` reads the key for `--reference-source` from
  them.
- `cupboard config --cache-credentials` and `CUPBOARD_CACHE_CREDENTIALS` are
  replaced by `--cache-access-keys` and `CUPBOARD_CACHE_ACCESS_KEYS`, a JSON
  array such as
  `[{"cache":{"kind":"named","name":"release"},"accessKey":"cupboard_ak_..."}]`.

The new options accept only an access key. They refuse a password or a token.

`cupboard session list` now reports the number of access keys below each tenant
session, and `cupboard session revoke` reports the number of keys that the
revocation deleted. A CLI from an earlier release can't read either response and
reports a failure. After `session revoke`, the server has still revoked the
session and deleted the keys. Use a CLI from this release to list and revoke
sessions.

#### Workflows and actions

The flake publish workflows replace the `read_user`, `read_password`,
`fallback_read_user`, `fallback_read_password`, `destination_read_user` and
`destination_read_password` secrets with two secrets:

```yaml
secrets:
  access_key: ${{ secrets.CUPBOARD_ACCESS_KEY }}
  view_access_key: ${{ secrets.CUPBOARD_VIEW_ACCESS_KEY }}
```

Supplying `access_key` replaces OIDC publishing: the jobs read the destination
cache and publish with the key. The key therefore needs the publication grants
that the job's trust rule gives, and Nix also reads the reuse view with it, so
give it `view:content-read` for a private view. A job that can use OIDC should
not supply `access_key`, because its trust rule already grants the content reads
and publication. `view_access_key` reads a private reuse view or reference
source in the plan and cohort steps. Supply neither when the job reads and
publishes with OIDC.

The actions change in the same way:

- `plan`, `build-cohort`, `attest`, `attest-attach` and `attest-status` replace
  `read-user` and `read-password` with `access-key`.
- `plan` and `build-cohort` replace `fallback-read-user` and
  `fallback-read-password` with `view-access-key`.
- `setup` replaces `read-user` and `read-password` with `access-key`, and
  `destination-read-user`, `destination-read-password` and `cache-credentials`
  with `cache-access-keys`.

An action that receives a key needs a cupboard CLI from this release or later.
With an older `cupboard-version`, the action stops before it runs the CLI.

#### Rolling back

The preceding release doesn't accept access keys, so every reader that uses one
gets 401 from a private cache until you deploy this release again. Once the
deploy's contract migration has run, the static read credentials are gone from
D1, and the preceding release finds none to accept either.

The preceding release also refuses access tokens and refresh credentials whose
grants list an access-key operation, such as `access-key:create`. This release
issues them to an administrator whose trust rule grants such an operation. After
a rollback, that administrator's current token gets 401 until it expires, and
the next refresh fails, so they must run `cupboard login` again.
