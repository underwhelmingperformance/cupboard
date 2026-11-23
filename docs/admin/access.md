# Who can use your tenant

There are three things someone might want to do with your tenant, and each is
controlled differently:

- Administer it, which means creating caches, changing settings and adding other
  administrators. You allow this by adding a trust rule for the person.
- Publish to it from CI, which means pushing store paths from a GitHub Actions
  job. You allow this by adding a trust rule for the job.
- Read a private cache, which means downloading store paths with Nix. A trust
  rule can permit OIDC content reads in CI, or you can create an
  [access key](#access-keys) for the reader. See [Private reads in
  CI][private-ci-reads].

[private-ci-reads]: ../ci/private-caches.md

Anyone can read a public cache. They don't need anything.

## Trust rules

Administrators and CI jobs don't have cupboard passwords. They sign in with a
token from an identity provider: Cloudflare or another OpenID Connect provider
for an administrator, and GitHub's own OIDC token for a GitHub Actions job. A
**trust rule** tells your tenant which tokens to accept, and what the holder of
each one is allowed to do. For example, one rule might say "accept tokens from
Cloudflare for this particular user, and let them do anything". Another might
say "accept tokens from GitHub Actions for the `acme/app` repository, and let
them push to that pull request's cache".

This page covers rules for administrators. [Trust rules](../ci/trust-rules.md)
covers rules for CI in detail.

Your tenant always has one rule called `owner`. It matches the tenant's owner,
whom the operator specified when creating the tenant. The rule can't be removed.

## Adding an administrator

To add an administrator, you need three things from them: the issuer, audience
and subject of their identity. They can find these themselves, before they have
any access, by running:

```sh
cupboard whoami --provider
```

This signs them in to their identity provider and prints the values, without
contacting cupboard. See
[Finding the identity to ask for access with](./signing-in.md#finding-the-identity-to-ask-for-access-with).

For someone who signs in with Cloudflare, the issuer and audience are always the
same. Put their subject into a file called `admin.json`:

```json
{
  "issuer": "https://dash.cloudflare.com",
  "audience": "6c915db1f16ece47255821ee6ca1d538",
  "claims": { "sub": "<their subject>" },
  "permittedGrants": [{ "type": "cupboard_wildcard" }]
}
```

`cupboard_wildcard` gives them full access to the tenant.

Then add the rule:

```sh
cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \
  --from-file admin.json
```

The file contains the whole rule, so `--from-file` can't be combined with
`--issuer`, `--audience` or the other options that build a rule.

The new administrator can now [sign in](./signing-in.md):

```sh
cupboard login https://cupboard.example.workers.dev/t/acme
```

If they use a different identity provider, put that provider's issuer and client
ID in the rule instead. They then sign in with the `--oidc-issuer` and
`--client-id` options.

## Removing an administrator

List the rules, and find the one to remove:

```sh
cupboard oidc-trust list https://cupboard.example.workers.dev/t/acme
```

Each row shows the rule's ID, its grants, its full issuer and its audience. When
the rule accepts only one subject, the row shows the subject after the issuer,
as in `https://dash.cloudflare.com · <their subject>`, so you can tell the rules
for different people apart.

Then remove it by its ID:

```sh
cupboard oidc-trust remove https://cupboard.example.workers.dev/t/acme <rule-id>
```

Removing a rule disables it rather than deleting it, so it still appears in the
list, marked as disabled.

If no remaining matching rules permit the person's session authority, their
session cannot be renewed. Their current access token expires within ten
minutes. Another matching rule can continue to permit renewal under current
policy. If the rule was for a CI job, any tokens that the job has already
received expire within 15 minutes.

## Letting CI publish

A CI job needs a trust rule that accepts its token and allows exactly what the
job does, and nothing more. If you use cupboard's flake publish workflow,
`cupboard github setup` creates the rules that it needs. See the
[CI quickstart](../ci/quickstart.md), and [Trust rules](../ci/trust-rules.md) if
you want to write rules yourself.

## Access keys

An access key is a long-lived secret with its own grants. Nix uses one to read a
private cache, and a script or a CI system without OIDC can use one to publish.
See [Private caches](../use/private-caches.md) for giving a key to Nix, and
[Publishing without OIDC](../ci/access-keys.md) for publishing with one.

Create a key with `cupboard access-key create`. The `--allow`, `--cache`,
`--root` and `--view` options build the grants in the same way as for a trust
rule, and `--grants-file` reads them from a JSON file instead. You must choose
an expiry: `--expires-in`, `--expires-at` or `--no-expiry`.

```sh
cupboard access-key create https://cupboard.example.workers.dev/t/acme \
  --allow read --cache release --expires-in 90d
```

The command prints the key once. The deployment keeps only a SHA-256 hash of it.

A new key can have only grants that you have yourself. Its expiry can be no
later than the expiry of the credential that creates it, unless that credential
also has `access-key:create` for every resource in the new key's grants. With
`access-key:create`, any expiry is allowed, and so is `--no-expiry`. An
administrator with the wildcard grant has `access-key:create` for everything.

A key's grants select caches and reuse views by name. Removing a cache or a view
doesn't delete or change the keys whose grants select it. A new cache or view
with the same name is then available to those keys at once, so delete the keys
before you remove the cache. `cupboard cache remove` leaves them in place.

A trust rule can grant `access-key:create`, `access-key:list` and
`access-key:delete` on a cache, on a reuse view, or for the whole tenant as a
domain grant. A cache or view grant covers the keys whose grants select that
cache or view. A domain grant covers only the keys whose grants are all domain
grants, so it doesn't cover a key that reads a cache or a view. You can list or
delete a key only when your grants include `access-key:list` or
`access-key:delete` for every resource in the key's grants.

A key can create keys of its own, so keys form chains. A chain is at most three
keys long. The keys below one sign-in session, at any depth, belong to one
origin. A token without a session, such as a CI token, creates keys with no
parent, and the keys of one subject that have no session above them belong to
one origin too. One origin can have at most 256 unexpired keys, and a tenant can
have at most 10,000 keys. An expired key counts towards the tenant limit until
collection deletes it, which happens soon after it expires. When your session's
origin is full, delete keys that are no longer needed, or run `cupboard login`
again to start a new session.

To see the keys, with their grants and expiry, run:

```sh
cupboard access-key list https://cupboard.example.workers.dev/t/acme
```

To delete a key and every key created below it, pass its ID:

```sh
cupboard access-key delete https://cupboard.example.workers.dev/t/acme <id>
```

Admin, upload and commit requests with a deleted key fail at once. The read
routes can still accept the key for up to five minutes, because the Worker
remembers each key that it has checked for that long. Work that the key started
before the deletion can continue for up to 15 minutes: a commit session that the
key opened, and an upload credential that it obtained, stay valid until then.

A key also stops working in these cases:

- It expires.
- No enabled trust rule still gives the identity that created it the key's
  grants. Removing a trust rule doesn't delete the keys, but it stops the ones
  that only that rule allowed.
- An administrator revokes the sign-in session above it, with
  `cupboard session revoke`. Revoking deletes every key below the session, at
  any depth, even when the session has already ended. It needs only the
  `session:revoke` permission, not `access-key:delete` for the keys.
- The deployment can't read its grants. A release ignores operations that it
  doesn't know and drops a grant with none left. The grants are unreadable when
  no grant remains, or when a grant has a type or a binding that the release
  doesn't know. That can happen after a rollback to a release that predates the
  key's grants. The key stays stored and works again after a roll-forward.
  `cupboard access-key list` shows it, marked as unreadable, only to an
  administrator with the wildcard grant, who can delete it with
  `cupboard access-key delete`.

Ending a session doesn't stop the keys below it. A session ends when you run
`cupboard logout`, when it expires, and when the server detects a replayed
refresh token: a refresh token that was already used arrives again after the
retry grace. A replay follows a lost refresh response or a restored backup of
the CLI's sessions as well as a stolen token, so the server ends the session and
keeps the keys below it. A key created with `access-key:create` outlives the
session. Any other key below it expires no later than the token that created it.

The CLI that presents the replayed token reports that the session ended because
a refresh token was used twice. `cupboard session list` keeps showing that
session, with its subject, the time of the replay and the number of keys below
it, until you revoke it, or until it has expired and no keys remain below it.
`cupboard access-key list` shows the session's ID on each key created in it.

If a session may have been stolen, find it and revoke it, which deletes every
key below it, then check the keys that remain:

```sh
cupboard session list https://cupboard.example.workers.dev/t/acme
cupboard session revoke https://cupboard.example.workers.dev/t/acme <id>
cupboard access-key list https://cupboard.example.workers.dev/t/acme
```

`cupboard cache set-access` changes whether a cache is public or private, and
the change takes effect immediately. Making a cache private doesn't create a key
for it. Readers need a key with a content-read grant for the cache, or a CI
trust rule that permits content reads.
