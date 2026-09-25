# Private caches

A private cache only serves store paths to Nix clients that send a username and
password with each request. This page explains where you get those credentials,
and how to give them to Nix without leaking them to other users of the machine.

Set up the cache as a normal substituter first, as described in
[Using a cache](./nix-clients.md). The public signing key at `/pubkey` doesn't
need a credential, even for a private cache. Everything else does.

## Read credentials

A read credential is the username and password that Nix uses to read a private
cache. There are two kinds.

The tenant read credential reads most private caches in the tenant. It works for
every private cache that doesn't have a credential of its own. It also works for
every private [reuse view](../ci/reuse-views.md).

A cache read credential reads a single cache. When a cache has its own
credential, it accepts only that one, and the tenant read credential no longer
works for it. Use a cache read credential when you want to share one cache with
a reader who shouldn't see the tenant's other private caches.

Only the deployment's operator can issue read credentials of either kind, so ask
them for one. The operator's side is described in
[Read credentials](../operator/tenants.md#read-credentials).

The username is `cupboard`, unless the operator chose a different one. The
password is 43 characters long. The deployment doesn't keep a copy of the
password. It keeps only a salted SHA-256 hash of it. If you lose the password,
the operator has to issue a new one.

## Giving credentials to Nix

Nix can read a credential from two places. Each suits one kind of credential.

A netrc file contains one username and password for each host. You tell Nix
where the file is with the `netrc-file` setting. Use it for the tenant read
credential:

```
machine cupboard.example.workers.dev login cupboard password <password>
```

A substituter URL can include its own username and password. For that URL, they
take priority over the netrc file. Use this for a cache read credential:

```
extra-substituters = https://reader:<password>@cupboard.example.workers.dev/t/acme/cache/release
```

Both contain secrets. Don't put them in the Nix store, because any user on the
machine can read it. Don't put them in `/etc/nix/nix.conf` either, because that
file is usually readable by everyone too.

### Generating the configuration with `cupboard config`

`cupboard config` can write both for you. It reads the credentials from
environment variables:

- `CUPBOARD_CACHE_CREDENTIALS` contains cache read credentials, as JSON.
  `cupboard config` puts them into the substituter lines that it prints.
- `CUPBOARD_READ_USER` and `CUPBOARD_READ_PASSWORD` contain the tenant read
  credential. `cupboard config` shows the matching netrc line as a message on
  standard error, not in its output, because the line belongs in a different
  file.

For example, to set up the default cache with the tenant read credential and the
`release` cache with its own credential:

```sh
export CUPBOARD_READ_USER=cupboard CUPBOARD_READ_PASSWORD=<password>
export RELEASE_USER=reader RELEASE_PASSWORD=<password>
export CUPBOARD_CACHE_CREDENTIALS=$(jq -nc \
  '[{cache: {kind: "named", name: "release"}, credential: {user: env.RELEASE_USER, password: env.RELEASE_PASSWORD}}]')

cupboard config https://cupboard.example.workers.dev/t/acme \
  "$(cupboard pubkey https://cupboard.example.workers.dev/t/acme)" \
  --include-default-cache release > cupboard-substituters.conf
```

Passing the passwords in environment variables keeps them off the command line,
where other users of the machine could see them.

Every entry in `CUPBOARD_CACHE_CREDENTIALS` must be for one of the caches that
you're configuring. Otherwise the command fails.

## Linux and macOS, without NixOS

1. Write the tenant read credential to a netrc file that only root can read:

   ```sh
   sudo install -m 0600 /dev/null /etc/nix/netrc
   echo 'machine cupboard.example.workers.dev login cupboard password <password>' \
     | sudo tee /etc/nix/netrc > /dev/null
   ```

2. Write the substituter lines, including any cache read credentials, to another
   file that only root can read, such as `/etc/nix/cupboard.conf`. Use the same
   `install` and `tee` commands as in step 1.

3. Add these lines to `/etc/nix/nix.conf`, then restart the Nix daemon:

   ```
   netrc-file = /etc/nix/netrc
   include /etc/nix/cupboard.conf
   ```

The Nix daemon does the downloading, and it runs as root, so it can read both
files. When another user runs a Nix command, Nix can't read the included file
and skips it without an error. That's harmless.

## NixOS

Create the substituter file and the netrc file outside the Nix store, for
example with a secrets manager. Then point the cupboard module's
`substitutersFile` option at the substituter file, and Nix's `netrc-file`
setting at the netrc file:

```nix
{
  imports = [ inputs.cupboard.nixosModules.default ];

  nix.cupboard.caches = [
    {
      substitutersFile = "/run/secrets/cupboard-substituters";
      publicKeys = [ "cupboard-acme-1:..." ];
    }
  ];

  nix.settings.netrc-file = "/run/secrets/cupboard-netrc";
}
```

The module refuses a path inside the Nix store. It adds an `!include` line for
the file to `nix.conf`, so the URL and its credential never appear in the
configuration that everyone can read.

If a file included with `!include` is missing, Nix skips it. This lets NixOS
check `nix.conf` when it builds the system, before the file exists.

## If something goes wrong

### Nix doesn't use the cache

If Nix can't read an included file, it skips it without an error. The NixOS
module's `!include` skips a missing file too. Either way, the cache disappears
from the list of substituters without an error.

To see whether the daemon can see the cache, run:

```sh
sudo nix config show substituters
```

If the cache isn't listed, check the file's path, owner and permissions.

With a plain `include`, as in the Linux and macOS steps above, a missing file
behaves differently. Every Nix command fails instead.

### Nix gets a 401 response

A 401 response means that the cache doesn't accept the credential. Remember that
a cache with its own credential doesn't accept the tenant read credential.

## What a private cache protects

Every request through a private cache's URL needs a credential that the cache
accepts. That covers both narinfos, which describe a store path, and NARs, which
contain its contents. Every response has `cache-control: no-store`. The only
public route is `/pubkey`.

A cache serves a NAR only if one of its own store paths refers to it. Knowing a
NAR's hash doesn't let anyone fetch it from a cache that doesn't have it. The
public routes never serve a NAR that only private caches refer to.

Suppose only one store path in a cache refers to a NAR. When you delete that
path, the cache stops serving the NAR before the deletion reports success.

There is one limit. A NAR hash still identifies a store path's contents to
anyone who has a copy of those contents from somewhere else, and attestations
publish NAR hashes. See
[Attestations for private caches](../ci/attestation.md#private-caches) and
[Security](../security.md).
