# Operators

The **operator** administers the deployment as a whole. An operator can create
and remove tenants, issue read credentials, and deploy upgrades. The first
operator is whoever ran the first `cupboard init` from a terminal and confirmed
the claim. See [Who can deploy](./deploying.md#who-can-deploy). The CLI calls
the operator the deployment's admin.

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

`cupboard init` isn't a way to sign in. It deploys, and it needs an operator's
session before it changes anything. Once the new operator has signed in with
`cupboard login`, `init` uses that session.

## Removing an operator

List the rules to find the operator's rule:

```sh
cupboard control-oidc-trust list https://cupboard.example.workers.dev
```

Then remove it by its ID. This disables the rule rather than deleting it.

```sh
cupboard control-oidc-trust remove https://cupboard.example.workers.dev <rule-id>
```

The first operator's rule is called `signup`. Don't remove it unless another
operator can still sign in. Running `init` again doesn't bring it back, so if
you remove the last working rule, nobody can sign in as an operator.

## Restoring the first operator's rule

If the `signup` rule is removed or disabled, or another rule for the same issuer
and subject takes precedence over it, the first operator's session no longer has
full access. `cupboard init` then stops, even after signing them in, and says
that the token lacks the wildcard grant.

If another operator can still sign in, they can add the rule back. Put the first
operator's issuer, audience and subject in a file with the same shape as
`operator.json` above, and add it with
`cupboard control-oidc-trust add --from-file`. Then remove any other rule for
that issuer and subject with `cupboard control-oidc-trust remove`. The error
from `init` prints the operator's issuer and subject. The audience is the client
ID that they signed in with, which for a Cloudflare sign-in is
`6c915db1f16ece47255821ee6ca1d538`.

If nobody can sign in as an operator, nobody can change the rules through
cupboard. Restore the rule directly in the control database with Wrangler,
logged in to the Cloudflare account. Replace the database name, issuer, audience
and subject with the operator's:

```sh
npx wrangler d1 execute cupboard --remote --command "
  INSERT INTO control_trust
    (id, issuer, audience, claims_json, permitted_grants_json, created_at)
  VALUES ('signup', 'https://dash.cloudflare.com', 'cupboard-client',
    json_object('sub', 'cf-user-1'), '[{\"type\":\"cupboard_wildcard\"}]',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (id) DO UPDATE SET issuer = excluded.issuer,
    audience = excluded.audience, claims_json = excluded.claims_json,
    permitted_grants_json = excluded.permitted_grants_json, disabled_at = NULL"
```

If another rule for the operator's issuer and subject still takes precedence,
delete it in the same way with
`DELETE FROM control_trust WHERE id = '<rule id>'`. Then run `cupboard init`
again.

## How the CLI shows identities

The CLI shows your own identity by the `name`, `email`, `preferred_username` or
`sub` claim of your token, whichever it finds first. It reads the name from the
token each time, and the deployment doesn't store it. It shows any other
identity as the full issuer URL followed by the subject. That's the form in the
error that says who administers a deployment, and in `cupboard oidc-trust list`,
which shows each rule's issuer followed by its subject when the rule pins one.

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
