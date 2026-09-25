# Keys

Each tenant has two kinds of key. The deployment creates both and keeps them.
You never handle the private halves yourself, but you may need to replace a key,
for example if you think it has leaked. Replacing a key is called rotating it.

- The **signing key** proves to Nix that store paths really came from your
  tenant. Nix clients trust its public half. You manage it with `cupboard key`.
- The **access-token key** signs the short-lived tokens that the tenant gives to
  administrators and CI jobs after they sign in. Nothing outside the deployment
  needs to know about it. You manage it with `cupboard auth-key`.

The deployment also has control keys of its own. Those belong to the operator.
See [Control keys](../operator/operators.md#control-keys).

All the commands on this page take the tenant URL, and you need to be
[signed in](./signing-in.md).

## The signing key

When Nix downloads a store path, it first fetches a narinfo, a small file that
describes the store path. Your tenant signs every narinfo that it serves with
each of its signing keys. Nix only accepts the narinfo if the signature matches
a public key listed in its `trusted-public-keys` setting.

A key's name identifies its deployment, tenant and generation:

```
cupboard-acme-1:...
```

Here, `cupboard` is the deployment's instance name, chosen when it was first
deployed. `acme` is the tenant's name, and `1` is the key's generation.

If the instance name or tenant name contains a hyphen, it's doubled in the key
name, so the name can only be read one way. For example, the instance
`acme-cache` and the tenant `web` give the key name `acme--cache-web-1`.

To see the tenant's keys and their states, run:

```sh
cupboard key list https://cupboard.example.workers.dev/t/acme
```

`cupboard pubkey` and the `/pubkey` URL print every public key that the tenant
currently publishes, one on each line.

## Rotating the signing key

Rotating the signing key replaces it with a new one. If you follow these steps,
Nix clients keep working throughout. During the rotation, the old key is called
the outgoing key and the new one the incoming key.

1. Start the rotation:

   ```sh
   cupboard key rotate https://cupboard.example.workers.dev/t/acme
   ```

   This adds the incoming key and prints its public key. From now on, new
   narinfos are signed with both keys. Existing narinfos are re-signed with the
   incoming key in the background.

   You can't start a rotation while an earlier rotation is still re-signing.

2. Add the incoming public key to every client's `trusted-public-keys`. Keep the
   outgoing key there too, for now.

3. Wait for the re-signing to finish. To check on it, run:

   ```sh
   cupboard key status https://cupboard.example.workers.dev/t/acme
   ```

   The incoming key's row shows `backfill running` while the re-signing is in
   progress, and `backfill complete` when it has finished.

4. Retire the outgoing key. Identify it by the ID that `cupboard key list`
   shows. The tenant's first key has the ID `active`. Later keys have UUIDs.

   ```sh
   cupboard key retire https://cupboard.example.workers.dev/t/acme active
   ```

   The tenant stops signing with the outgoing key. It still publishes the key at
   `/pubkey`, though, so clients that have cached narinfos signed only by that
   key can still check them.

5. Remove the outgoing key from every client's `trusted-public-keys`.

6. Retire the outgoing key a second time. The tenant then stops publishing it at
   `/pubkey`.

   ```sh
   cupboard key retire https://cupboard.example.workers.dev/t/acme active
   ```

### How long to keep trusting the old key

Nix keeps the narinfos that it has downloaded, signatures included, for as long
as its `narinfo-cache-positive-ttl` setting says. That's 30 days by default.
Until then, a client may still have narinfos signed only by the outgoing key.

So keep the outgoing key in clients' `trusted-public-keys` until that long after
the re-signing finished. Alternatively, clear the clients' narinfo caches.

### Rules for retiring a key

- You can't retire the outgoing key until the re-signing has finished.
- You can never retire the tenant's last signing key.
- `cupboard key retire` asks you to confirm. In a script, add `--yes` to skip
  the question.

The deployment can't see how clients are configured. Removing a key from
`/pubkey` doesn't remove it from anyone's `trusted-public-keys`. You have to do
that on each client.

### Abandoning a rotation

Until the re-signing has finished, you can abandon a rotation. This removes the
incoming key and stops its unfinished re-signing:

```sh
cupboard key abort https://cupboard.example.workers.dev/t/acme <incoming-key-id>
```

## Access-token keys

After an administrator or a CI job signs in, the tenant gives them a short-lived
token to use with each request. The tenant signs these tokens with its
access-token key. Rotating this key doesn't affect Nix clients or narinfos at
all.

To rotate it, run:

```sh
cupboard auth-key rotate https://cupboard.example.workers.dev/t/acme
```

The new key starts signing tokens straight away. The old key is scheduled to
retire about 20 minutes later, once every token that it signed has expired. The
hourly maintenance job then retires it, so you don't need to do anything else.
`cupboard auth-key list` shows when the retirement is scheduled.

### Cutting off old tokens straight away

Sometimes you don't want to wait, for example if a token has leaked. In that
case, once the rotation is done, retire the old key yourself:

```sh
cupboard auth-key retire https://cupboard.example.workers.dev/t/acme <old-key-id>
```

Tokens signed by the old key stop working immediately. Administrators and CI
jobs that still need access then fetch new tokens.

This doesn't end anyone's session. Access-token keys don't sign refresh tokens,
so a signed-in administrator can still renew their session. To take away an
administrator's access, remove their
[trust rule](./access.md#removing-an-administrator).
