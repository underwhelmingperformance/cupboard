# Managing tenants

As the operator, you create tenants, set storage quotas, and suspend or remove
tenants. This page covers each of these. Readers of a private cache use access
keys, which the tenant's administrators create; see
[Access keys](../admin/access.md#access-keys).

Operator commands take the deployment URL, such as
`https://cupboard.example.workers.dev`, rather than a tenant URL. They also need
an operator session. `init` leaves you signed in. If your session has ended,
sign in again with:

```sh
cupboard login https://cupboard.example.workers.dev
```

Operator tokens last ten minutes. The CLI renews them with the session's refresh
token for up to 30 days after you signed in. When the session can't be renewed,
run `cupboard login` again.

## Creating a tenant

`init` creates the first tenant for you. To create another, you need to know who
will own it. The owner is the identity that administers the tenant, and it can't
be changed later. For someone who signs in with Cloudflare, the issuer and
audience are always the same, and you only need their Cloudflare subject. They
can find it themselves with
[`cupboard whoami --provider`](../admin/signing-in.md#finding-the-identity-to-ask-for-access-with).

Then create the tenant:

```sh
cupboard tenant create https://cupboard.example.workers.dev acme \
  --owner-issuer https://dash.cloudflare.com \
  --owner-audience 6c915db1f16ece47255821ee6ca1d538 \
  --owner-subject <their subject> \
  --access private
```

Here, `acme` is the tenant's slug. It becomes part of the tenant URL,
`https://cupboard.example.workers.dev/t/acme`. A slug can be 1 to 63 characters
long, can contain lower-case letters, digits, `.`, `_` and `-`, and must start
with a letter or a digit. A slug can never be used again, even after the tenant
is removed.

`--access` sets whether the tenant's default cache is public or private. It is
required, as are the three `--owner-` options.

The owner must be a person who signs in with `cupboard login`. The deployment
refuses `https://token.actions.githubusercontent.com` as the owner's issuer,
with status 400 and the code `TENANT_OWNER_ISSUER_UNSUPPORTED`. Every repository
on GitHub can request a token from that issuer, and the owner's rule can require
only the `sub` claim, which contains at most the repository's name. To let a
GitHub Actions workflow publish, the owner adds a trust rule for it with
`cupboard github setup`; see [Trust rules](../ci/trust-rules.md).

The owner's issuer URL must match exactly on later attempts to create the same
tenant, including any trailing slash. A different spelling returns a conflict.

You can also limit how much storage the tenant can use with `--quota-bytes`. By
default there's no limit. See [Changing a quota](#changing-a-quota).

Sometimes the deployment creates the tenant but can't publish its membership,
which admission checks before it serves a request. The command then sends the
same request twice more, waiting up to 10 seconds before each. If those fail
too, or a later request fails in another way, the command reports that the
tenant exists but its membership isn't published. Until the membership is
published, requests to the tenant can get 404. Run `cupboard deploy` again to
publish it.

Once the tenant exists, the owner can sign in and add other administrators
themselves. See [Who can use your tenant](../admin/access.md).

```sh
cupboard login https://cupboard.example.workers.dev/t/acme
```

To see every tenant and its state, including removed tenants, run:

```sh
cupboard tenant list https://cupboard.example.workers.dev
```

## Changing a quota

A quota limits how much storage a tenant can use. Each distinct NAR and
attestation bundle is counted once per tenant, however many store paths or
caches refer to it. NARs count by compressed file size. Attestation bundles
count by their stored byte length.

To inspect the quota and storage usage without changing either value:

```sh
cupboard tenant quota https://cupboard.example.workers.dev acme
```

The command uses the control API. A control token without the wildcard grant
needs a `cupboard_tenant` grant with `tenant:read-quota` for `acme`. The command
can read the quota of a suspended tenant or a tenant whose removal is in
progress. After removal finishes, the quota and usage are no longer available.

To set a quota of 50 GB on the `acme` tenant:

```sh
cupboard tenant set-quota https://cupboard.example.workers.dev acme 50000000000
```

You can also pass `--quota-bytes 50000000000`, as on `tenant create`, instead of
the positional byte count. Pass the quota once, using either form. Both forms
accept zero; use `clear-quota` to remove the limit.

To remove the quota:

```sh
cupboard tenant clear-quota https://cupboard.example.workers.dev acme
```

Both commands print the new quota and how much storage the tenant is currently
using. The next upload is checked against the new quota.

You can't set a quota below what the tenant already stores. Choose a larger
quota, or ask the tenant's administrators to free some space first.

You can change a suspended tenant's quota, but not the quota of a tenant that is
being removed.

## Suspending a tenant

Suspending a tenant blocks most access immediately:

- Reads return 404.
- Pushes, sign-in and administration are refused.
- Refresh tokens can still be revoked, so `cupboard logout` still ends a
  session. The session remains ended after the tenant is resumed.
- Scheduled maintenance, including garbage collection, pauses.

```sh
cupboard tenant suspend https://cupboard.example.workers.dev acme
```

To bring the tenant back, resume it:

```sh
cupboard tenant resume https://cupboard.example.workers.dev acme
```

## Removing a tenant

```sh
cupboard tenant remove https://cupboard.example.workers.dev acme
```

Removal cannot be undone. `cupboard tenant list` shows `Removal in progress`
until removal finishes, then `Removed`. Configuration versions appear only with
`--debug`.

Reads and writes stop immediately. After that, an hourly job deletes the
tenant's caches, keys, credentials and trust rules, working through a few
tenants each hour. Once that's done, stored files that no other tenant uses are
deleted too.

You can't undo a removal once it has started, and you can't suspend or resume
the tenant any more. The slug stays reserved, so it can't be used for a new
tenant.

`suspend` and `remove` both ask you to confirm. In a script, add `--yes` to skip
the question.
