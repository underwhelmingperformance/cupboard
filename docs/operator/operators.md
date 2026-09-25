# Operators

An **operator** administers the deployment as a whole. An operator can create
and remove tenants, issue read credentials, and deploy upgrades. The first
operator is the deployment's **admin**: whoever
[claimed the deployment](./deploying.md#claiming-the-deployment) when they first
ran `cupboard init`. The deployment records the admin in the `global_admin` row
of its D1 database.

An operator is anyone whose control-plane trust rule gives the
[wildcard grant](../concepts.md#signing-in-and-trust-rules). The claim creates
such a rule for the admin, with the ID `signup`.

Being an operator doesn't give you access to a tenant's caches or settings. You
only have that if you're also the tenant's owner or one of its administrators.

## Adding operators

A deployment can have more than one operator. You add an operator by adding a
**control-plane trust rule** that matches their identity. These rules work like
a tenant's [trust rules](../ci/trust-rules.md), except that each one must match
an exact `sub` claim, so it only ever matches one identity.

First, ask the new operator for their subject. They can find it themselves,
before they have any access, with
[`cupboard whoami --provider`](../admin/signing-in.md#finding-the-identity-to-ask-for-access-with).

For someone who signs in with Cloudflare, the issuer and audience are always the
same. Put their subject into a file called `operator.json`:

```json
{
  "issuer": "https://dash.cloudflare.com",
  "audience": "6c915db1f16ece47255821ee6ca1d538",
  "claims": { "sub": "<their subject>" },
  "permittedGrants": [{ "type": "cupboard_wildcard" }]
}
```

Then add the rule:

```sh
cupboard control-oidc-trust add https://cupboard.example.workers.dev \
  --from-file operator.json
```

The new operator can now sign in with the deployment URL:

```sh
cupboard login https://cupboard.example.workers.dev
```

Their session also lets them [upgrade the deployment](./upgrading.md) with
`cupboard init`, because `init` accepts any admin token with the wildcard grant.

## Removing an operator

List the rules to find the operator's rule:

```sh
cupboard control-oidc-trust list https://cupboard.example.workers.dev
```

Then remove it by its ID. This disables the rule rather than deleting it.

```sh
cupboard control-oidc-trust remove https://cupboard.example.workers.dev <rule-id>
```

The admin's rule is called `signup`. Don't remove it unless another operator can
still sign in. Running `init` again doesn't bring it back. If it's gone, see
[Restoring the admin's wildcard grant](#restoring-the-admins-wildcard-grant).

## Restoring the admin's wildcard grant

If the `signup` rule is removed or disabled, or another rule for the admin's
issuer and subject takes precedence, the admin's token no longer has the
wildcard grant. `cupboard init` then stops even after it signs you in as the
admin.

Adding or removing a control trust rule needs a token that allows it: one with
the wildcard grant, or with a `cupboard_control` grant that lists
`control-oidc-trust:add` and `control-oidc-trust:remove`. Someone with such a
token, for example another operator, signs in with
`cupboard login <deployment URL>`. They add a rule for the admin with
`cupboard control-oidc-trust add --from-file`, and remove any other rule for the
admin's issuer and subject with `cupboard control-oidc-trust remove`. The rule
pins the admin's issuer, audience and `sub` claim, and has
`"permittedGrants": [{ "type": "cupboard_wildcard" }]`, as in
[Adding operators](#adding-operators).

If nobody has such a token, nobody can change the control trust rules through
the deployment. Restore the `signup` rule directly in the control database with
Wrangler, signed in to the account. Replace the database name, issuer, audience
and subject with the admin's:

```sh
npx wrangler d1 execute cupboard --remote --command "
  INSERT INTO control_trust
    (id, issuer, audience, claims_json, permitted_grants_json, created_at)
  VALUES ('signup', 'https://dash.cloudflare.com', '6c915db1f16ece47255821ee6ca1d538',
    json_object('sub', 'cf-user-1'), '[{\"type\":\"cupboard_wildcard\"}]',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (id) DO UPDATE SET issuer = excluded.issuer,
    audience = excluded.audience, claims_json = excluded.claims_json,
    permitted_grants_json = excluded.permitted_grants_json, disabled_at = NULL"
```

When `init` stops, it prints the admin's issuer and subject. The audience is the
OAuth client ID that the admin claimed with. With the default sign-in, it's
cupboard's Cloudflare client ID, `6c915db1f16ece47255821ee6ca1d538`. If another
rule for the admin's issuer and subject still takes precedence, delete it in the
same way with `DELETE FROM control_trust WHERE id = '<rule id>'`. Then run
`cupboard init` again.

## How principals are shown

The CLI shows your own identity by the `name`, `email`, `preferred_username` or
`sub` claim of your token, whichever it finds first in that order. It reads this
from your token each time. The deployment doesn't store it.

Other identities appear as the full issuer URL followed by the subject, such as
`https://dash.cloudflare.com · 7c1e2a90-4d3b-4f6e-9a51-0b8c3d2e1f47`.
`cupboard init` shows the admin in this form when it updates a deployment.
`cupboard control-oidc-trust list` and `cupboard oidc-trust list` show each
rule's full issuer URL, followed by the subject when the rule pins one.

## Control keys

Operator tokens are signed with the deployment's control keys. The deployment
stores these keys encrypted with `CONTROL_KEY_WRAP_SECRET`. You rotate them in
the same way as a tenant's
[access-token keys](../admin/keys.md#access-token-keys).

To create a new control key, and see the current ones:

```sh
cupboard control-key rotate https://cupboard.example.workers.dev
cupboard control-key list https://cupboard.example.workers.dev
```

Rotating schedules the old key to be retired about 20 minutes later. The hourly
job then retires it.

If you want to retire the old key sooner, wait at least 11 minutes after
rotating first. Operator tokens last ten minutes, so by then no valid token is
still signed with the old key. Then run:

```sh
cupboard control-key retire https://cupboard.example.workers.dev <old-key-id>
```

You can't retire the last control key.
