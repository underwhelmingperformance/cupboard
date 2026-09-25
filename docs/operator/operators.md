# Operators

The **operator** administers the deployment as a whole. An operator can create
and remove tenants, issue read credentials, and deploy upgrades. The first
operator is whoever first completed `cupboard init`.

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

They shouldn't run `cupboard init` to sign in. `init` deploys first, and then
fails when it tries to claim a deployment that already has an operator.

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
