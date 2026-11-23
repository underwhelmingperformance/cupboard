# Private caches

A private cache checks every request for read access. Nix sends a username and
password, and the password is an access key or a short-lived CI token. This page
explains how to give an access key to Nix on a machine. The [CI
guide][private-ci] covers OIDC reads in GitHub Actions.

[private-ci]: ../ci/private-caches.md

Set up the cache as a normal substituter first, as described in
[Using a cache](./nix-clients.md). The public signing key at `/pubkey` doesn't
need a credential, even for a private cache. Everything else does.

## Access keys

An access key is a secret that a tenant administrator creates for a machine or a
person. It looks like `cupboard_ak_<id>_<secret>`. Each key has grants, which
say what it can do, and usually an expiry. A key for Nix needs a content-read
grant for each cache or reuse view that it reads.

Ask a tenant administrator for a key. They create one with
`cupboard access-key create`; see [Access keys][admin-keys]. For example, this
creates a key that reads the default cache for 90 days:

[admin-keys]: ../admin/access.md#access-keys

```sh
cupboard access-key create https://cupboard.example.workers.dev/t/acme \
  --allow read --expires-in 90d
```

The command prints the key once. The deployment keeps only a SHA-256 hash of it,
so a lost key can't be recovered. Create a new one and delete the old one.

Nix sends the key as the password. The server ignores the username, so any
username works; this page uses `cupboard`.

A key for one tenant also reaches every other tenant on the same deployment URL,
because Nix chooses a netrc entry by host. Those tenants don't accept the key.
Their public caches still answer, and their private caches refuse the request.

## Giving a key to Nix

Nix can read a credential from two places.

A netrc file contains one username and password for each host. You tell Nix
where the file is with the `netrc-file` setting. Nix uses the entry for every
cache on that host:

```
machine cupboard.example.workers.dev login cupboard password cupboard_ak_...
```

A substituter URL can include its own username and password. For that URL, they
take priority over the netrc file. Use this when one cache needs a different key
from the others on the same host:

```
extra-substituters = https://cupboard:cupboard_ak_...@cupboard.example.workers.dev/t/acme/cache/release
```

Both contain secrets. Don't put them in the Nix store, because any user on the
machine can read it. Don't put them in `/etc/nix/nix.conf` either, because that
file is usually readable by everyone too.

### Generating the configuration with `cupboard config`

`cupboard config` can write both for you. It reads the keys from environment
variables:

- `CUPBOARD_CACHE_ACCESS_KEYS` contains an access key for each of several
  caches, as JSON. `cupboard config` puts each key into the substituter line of
  its cache.
- `CUPBOARD_ACCESS_KEY` contains the access key for every other cache that you
  configure. `cupboard config` shows the matching netrc line as a message on
  standard error, not in its output, because the line belongs in a different
  file.

For example, to set up the default cache with one key and the `release` cache
with its own key:

```sh
default_key=cupboard_ak_...
release_key=cupboard_ak_...
release_keys=$(RELEASE_KEY=$release_key jq -nc \
  '[{cache: {kind: "named", name: "release"}, accessKey: env.RELEASE_KEY}]')

(
  umask 077
  CUPBOARD_ACCESS_KEY=$default_key CUPBOARD_CACHE_ACCESS_KEYS=$release_keys \
    cupboard config https://cupboard.example.workers.dev/t/acme \
    "$(cupboard pubkey https://cupboard.example.workers.dev/t/acme)" \
    --include-default-cache release > cupboard-substituters.conf
)
unset default_key release_key release_keys
```

The shell variables are not exported. The assignments before `cupboard config`
set the environment variables for that one command. Do not export
`CUPBOARD_ACCESS_KEY` in an interactive shell: `cupboard push` and the other
commands listed in [Scripting the CLI][scripting] use it in place of your login
session.

The `--access-key` and `--cache-access-keys` options take the same values and
override the environment variables. Passing the keys in environment variables
keeps them off the command line, where other users of the machine could see
them. The output contains the `release` key, so `umask 077` makes the shell
create the file with mode 0600, readable only by you.

[scripting]: ../reference/cli-scripting.md#access-keys

Every entry in `CUPBOARD_CACHE_ACCESS_KEYS` must be for one of the caches that
you're configuring. Otherwise the command fails.

## Linux and macOS, without NixOS

1. Write the access key to a netrc file that only root can read:

   ```sh
   sudo install -m 0600 /dev/null /etc/nix/netrc
   echo 'machine cupboard.example.workers.dev login cupboard password cupboard_ak_...' \
     | sudo tee /etc/nix/netrc > /dev/null
   ```

2. Copy the substituter lines, including any keys for individual caches, to
   another file that only root can read. With the `cupboard-substituters.conf`
   file from
   [the example above](#generating-the-configuration-with-cupboard-config):

   ```sh
   sudo install -m 0600 cupboard-substituters.conf /etc/nix/cupboard.conf
   rm cupboard-substituters.conf
   ```

3. Add these lines to `/etc/nix/nix.conf`, or to `/etc/nix/nix.custom.conf` if
   you use Determinate Nix, then restart the Nix daemon as
   [Using a cache](./nix-clients.md) describes for your system:

   ```
   netrc-file = /etc/nix/netrc
   include /etc/nix/cupboard.conf
   ```

The Nix daemon does the downloading, and it runs as root, so it can read both
files. When another user runs a Nix command, Nix can't read the included file
and skips it without an error. That's harmless.

## NixOS and Home Manager

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
configuration that everyone can read. Nix adds the settings in the included file
to the ones that it has already read, so the private cache joins the other
substituters.

Give the substituter file mode 0400 or 0600. With the NixOS module, make it
readable only by the account that runs the Nix daemon, usually root. With the
Home Manager module, make it readable only by your own account. Restrict only
the file itself. Every account that reads `nix.conf` must be able to enter each
directory above the file, which needs search (execute) permission on it.
`/etc/nix` meets this requirement, and so do `/run/secrets` and `/run/agenix`,
which sops-nix and agenix create with mode 0751.

If a file included with `!include` is missing, Nix skips it. This lets NixOS
check `nix.conf` when it builds the system, before the file exists.

To check the NixOS module's configuration, run
`sudo nix config show substituters` and check that the private cache is listed.
The output includes the cache's credential. An ordinary user's output doesn't
list the private cache, but the builds that the daemon runs for that user still
use it. The exception is a user whose Nix client sends its own substituter list,
which happens when a user-level `nix.conf`, `NIX_CONFIG` or a command-line
option such as `--option substituters` or `--extra-substituters` sets
`substituters` or `extra-substituters`. That list lacks the private cache,
because the client can't read the file.

With the Home Manager module, run `nix config show substituters` as yourself.
The output includes the cache's credential. The daemon uses the private cache
for your builds only if you're a trusted user, as for any cache in a user's
configuration. See [Home Manager](./nix-clients.md#home-manager).

## If something goes wrong

### Nix doesn't use the cache

If Nix can't read an included file, it skips it without an error. The module's
`!include` skips a missing file too. Either way, the cache disappears from the
list of substituters without an error. Neither Nix nor cupboard reports it, so
check again after you create or move the file.

To see whether the daemon can see the cache, run:

```sh
sudo nix config show substituters
```

If the cache isn't listed, check the file's path, owner and permissions.

A directory above the file that an account can't search causes a bigger problem.
For that account, Nix ignores every setting in the `nix.conf` that includes the
file, again without an error. With the NixOS module, that's the system
`nix.conf`, so an ordinary user's Nix runs without the system's substituters,
trusted keys and experimental features. `sudo nix config show` doesn't show
this, because root can search every directory. As an ordinary user, run:

```sh
nix --extra-experimental-features nix-command config show trusted-public-keys
```

Check that the output lists the public key of a cache in `nix.cupboard.caches`.
The module writes that key into the same `nix.conf` as the `!include` line, so
if the key is missing, Nix ignored that file. Give every directory above the
file search permission for all accounts.

With a plain `include`, as in the Linux and macOS steps above, a missing file
behaves differently. Every Nix command fails instead.

### Nix gets a 401 response

A 401 response means that the cache doesn't accept the key. Check that the key
hasn't expired or been deleted, and that it has a content-read grant for this
cache or reuse view. `cupboard access-key list` shows each key's grants and
expiry.

## What a private cache protects

Every request through a private cache's URL needs a credential that the cache
accepts. That covers both narinfos, which describe a store path, and NARs, which
contain its contents. Every response has `cache-control: no-store`. The only
public route is `/pubkey`.

A cache serves a NAR only if one of its own store paths refers to it, at
`<cache URL>/nar/<hash>.<n>.nar.zst`. `<n>` is the version of the stored object,
and the narinfo's `URL` field contains that number. Version 1 is the legacy form
that earlier releases wrote. A NAR at version 1 is served at the unnumbered URL,
`<cache URL>/nar/<hash>.nar.zst`, while that object exists, and its narinfo's
`URL` field has no number. The default cache's URL is the tenant URL, so
`/t/<tenant>/nar/...` serves the NARs that the default cache refers to. A NAR
that two caches refer to is served under both URLs. Knowing a NAR's hash doesn't
let anyone fetch it from a cache that doesn't have it. The public routes never
serve a NAR that only private caches refer to.

Suppose only one store path in a cache refers to a NAR. When you delete that
path, the cache stops serving the NAR before the deletion reports success.

There is one limit. A NAR hash still identifies a store path's contents to
anyone who has a copy of those contents from somewhere else, and attestations
publish NAR hashes. See
[Attestations for private caches](../ci/attestation.md#private-caches) and
[Security](../security.md).
