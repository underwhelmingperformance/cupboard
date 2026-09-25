# Managing tenants

As the operator, you create tenants, issue the read credentials that Nix uses
for private caches, set storage quotas, and suspend or remove tenants. This page
covers each of these.

Operator commands take the deployment URL, such as
`https://cupboard.example.workers.dev`, rather than a tenant URL. They also need
an operator session. `init` leaves you signed in. If your session has ended,
sign in again with:

```sh
cupboard login https://cupboard.example.workers.dev
```

Operator tokens last ten minutes. The CLI renews them for you in the background,
using your cached Cloudflare sign-in.

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

The command also creates a tenant read credential, which Nix uses to read the
tenant's private caches. The user name is `cupboard`, and the command prints the
generated password. The password isn't shown again. These options change that:

- `--read-user` sets a different user name.
- `--no-read-password` doesn't create a credential at all. Nobody can read a
  private cache until it has a credential.

You can also limit how much storage the tenant can use with `--quota-bytes`. By
default there's no limit. See [Changing a quota](#changing-a-quota).

Once the tenant exists, the owner can sign in and add other administrators
themselves. See [Who can use your tenant](../admin/access.md).

```sh
cupboard login https://cupboard.example.workers.dev/t/acme
```

To see every tenant and its state, including removed tenants, run:

```sh
cupboard tenant list https://cupboard.example.workers.dev
```

## Read credentials

Only operators can issue read credentials. Tenant administrators can't.
[Read credentials](../use/private-caches.md#read-credentials) explains the two
kinds, the tenant read credential and cache read credentials, and which one a
cache accepts.

| Command                                                 | What it does                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `tenant rotate-credential <url> <tenant>`               | Replaces the tenant read credential and prints the new password.      |
| `tenant clear-credential <url> <tenant>`                | Removes the tenant read credential.                                   |
| `tenant rotate-cache-credential <url> <tenant> [cache]` | Creates or replaces a cache's own credential and prints the password. |
| `tenant clear-cache-credential <url> <tenant> [cache]`  | Removes a cache's own credential.                                     |

For example, to give the `release` cache of the `acme` tenant its own
credential:

```sh
cupboard tenant rotate-cache-credential https://cupboard.example.workers.dev \
  acme release
```

To do the same for the tenant's default cache, leave out the cache name:

```sh
cupboard tenant rotate-cache-credential https://cupboard.example.workers.dev \
  acme
```

The user name is `cupboard` unless you pass `--read-user`. Rotating a credential
doesn't remember a custom user name, so pass `--read-user` again every time you
rotate one.

Each password is printed only once, because the deployment only keeps a salted
SHA-256 hash of it. After you rotate a credential, everyone who reads the cache
has to update their Nix configuration with the new password.

Clearing a cache's own credential doesn't lock the cache. The cache goes back to
accepting the tenant read credential, so anyone who has the tenant read
credential can read the cache. A private cache with neither kind of credential
refuses every read.

## Changing a quota

A quota limits how much storage a tenant can use. Each file that the tenant
stores is counted once, at its compressed size, however many store paths or
caches use it. This covers both NARs and attestations.

To set a quota of 50 GB on the `acme` tenant:

```sh
cupboard tenant set-quota https://cupboard.example.workers.dev acme 50000000000
```

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

Suspending a tenant stops it completely, straight away:

- Reads return 404.
- Pushes, sign-in and administration are refused.
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

Reads and writes stop immediately. After that, an hourly job deletes the
tenant's caches, keys, credentials and trust rules, working through a few
tenants each hour. Once that's done, stored files that no other tenant uses are
deleted too.

You can't undo a removal once it has started, and you can't suspend or resume
the tenant any more. The slug stays reserved, so it can't be used for a new
tenant.

`suspend` and `remove` both ask you to confirm. In a script, add `--yes` to skip
the question.
