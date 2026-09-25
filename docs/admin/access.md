# Who can use your tenant

There are three things someone might want to do with your tenant, and each is
controlled differently:

- Administer it, which means creating caches, changing settings and adding other
  administrators. You allow this by adding a trust rule for the person.
- Publish to it from CI, which means pushing store paths from a GitHub Actions
  job. You allow this by adding a trust rule for the job.
- Read a private cache, which means downloading store paths with Nix. This needs
  a read credential. Only the deployment's operator can issue one.

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

Then remove it by its ID:

```sh
cupboard oidc-trust remove https://cupboard.example.workers.dev/t/acme <rule-id>
```

Removing a rule disables it rather than deleting it, so it still appears in the
list, marked as disabled.

The person loses access within ten minutes. Their session can't be renewed, and
their current access token expires within that time. If the rule was for a CI
job, any tokens that the job has already received expire within 15 minutes.

## Letting CI publish

A CI job needs a trust rule that accepts its token and allows exactly what the
job does, and nothing more. If you use cupboard's flake publish workflow,
`cupboard github setup` creates the rules that it needs. See the
[CI quickstart](../ci/quickstart.md), and [Trust rules](../ci/trust-rules.md) if
you want to write rules yourself.

## Letting people read private caches

Nix reads private caches using a username and password, not a trust rule. Only
the deployment's operator can issue these read credentials. See
[Read credentials](../use/private-caches.md#read-credentials).

You can make a cache public or private yourself, with
`cupboard cache set-access`. The change takes effect immediately.
