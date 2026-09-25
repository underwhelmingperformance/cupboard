# Using a cache

This page shows you how to set up Nix to download store paths from a cupboard
cache. cupboard speaks the standard Nix binary-cache protocol, so any Nix
installation can use it, in the same way that it uses cache.nixos.org.

You need two things, which the tenant administrator can give you:

- The cache URL. Nix downloads store paths from this address.
- The tenant's public signing key. cupboard signs every store path that it
  serves, and Nix only accepts store paths that a trusted key has signed.

The steps here are for a public cache, which anyone can read. If the cache is
private, follow this page first and then [Private caches](./private-caches.md).

## Finding the cache URL

Every tenant has a default cache. Its URL is the tenant URL:

```
https://cupboard.example.workers.dev/t/acme
```

A tenant can also have named caches. Each named cache has its own URL, under the
tenant URL:

```
https://cupboard.example.workers.dev/t/acme/cache/release
```

Nix treats each cache as a separate substituter. A store path published to one
cache isn't served by any other, so add every cache that you want to use.

A cache's URL never changes, even when the tenant administrator makes it public
or private.

## Getting the public key

The public key is public even when the cache is private. You can fetch it
without installing anything:

```sh
curl -fsS https://cupboard.example.workers.dev/t/acme/pubkey
```

```
cupboard-acme-1:...
```

The key's name starts with the deployment's instance name, here `cupboard`,
followed by the tenant's name, here `acme`.

From time to time the tenant administrator replaces the key. While that's
happening, `/pubkey` lists two keys, one on each line, and you should trust
both. [Rotating the signing key](../admin/keys.md#rotating-the-signing-key)
explains what a rotation means for you.

Fetching the key from the deployment means trusting whatever the deployment
returns. If you can, compare the key with a copy that you got some other way,
such as from the tenant administrator. That protects you if the deployment is
compromised or someone is impersonating it.

## Configuring Nix

To use the cache alongside cache.nixos.org, Nix needs these two settings:

```
extra-substituters = https://cupboard.example.workers.dev/t/acme
extra-trusted-public-keys = cupboard-acme-1:...
```

If you have the `cupboard` CLI installed, `cupboard config` prints these lines
for you:

```sh
cupboard config https://cupboard.example.workers.dev/t/acme \
  "$(cupboard pubkey https://cupboard.example.workers.dev/t/acme)"
```

To set up several named caches, list their names after the key:

```sh
cupboard config https://cupboard.example.workers.dev/t/acme \
  "$(cupboard pubkey https://cupboard.example.workers.dev/t/acme)" \
  release nightly
```

When you list caches, the default cache isn't included. Add
`--include-default-cache` to include it as well.

`cupboard config` writes only the configuration lines to standard output, so you
can redirect them straight into a file.

Where the lines go depends on how Nix is installed. The sections below cover the
common set-ups.

### Linux, without NixOS

Add the lines to the end of `/etc/nix/nix.conf`, then restart the Nix daemon:

```sh
sudo systemctl restart nix-daemon
```

### macOS

Add the lines to the end of `/etc/nix/nix.conf`. If you use Determinate Nix, add
them to `/etc/nix/nix.custom.conf` instead. Then restart the Nix daemon. With
the official installer, run:

```sh
sudo launchctl kickstart -k system/org.nixos.nix-daemon
```

If nix-darwin manages your Nix installation, use its `nix.settings` option
instead, as shown in the next section.

### NixOS and nix-darwin

Set the options in your system configuration:

```nix
{
  nix.settings = {
    extra-substituters = [ "https://cupboard.example.workers.dev/t/acme" ];
    extra-trusted-public-keys = [ "cupboard-acme-1:..." ];
  };
}
```

On NixOS, you can use the cupboard flake's module instead. It can also set up
private caches:

```nix
{
  imports = [ inputs.cupboard.nixosModules.default ];

  nix.cupboard.caches = [
    {
      url = "https://cupboard.example.workers.dev/t/acme";
      publicKeys = [ "cupboard-acme-1:..." ];
    }
  ];
}
```

Each entry needs `publicKeys` and exactly one of these:

- `url`, for a public cache.
- `substitutersFile`, for a private cache. See
  [Private caches](./private-caches.md#nixos).

The module adds the caches to the system's substituters. It keeps
cache.nixos.org.

### Home Manager

The same module is available for Home Manager as
`inputs.cupboard.homeManagerModules.default`. It writes your user's `nix.conf`,
so Home Manager's `nix.package` option must be set. Like the NixOS module, it
adds to the substituters and keys that Nix already has, using
`extra-substituters` and `extra-trusted-public-keys`.

The Nix daemon ignores a user's substituters and keys unless one of these is
true:

- The user is listed in the daemon's `trusted-users`.
- The cache is listed in the daemon's `trusted-substituters`, and the key in its
  `trusted-public-keys`.

Because of this, it's usually better to configure caches system-wide if you can.

### A flake's `nixConfig`

A flake can ask Nix to use a cache while it builds that flake:

```nix
{
  nixConfig = {
    extra-substituters = [ "https://cupboard.example.workers.dev/t/acme" ];
    extra-trusted-public-keys = [ "cupboard-acme-1:..." ];
  };
}
```

This has some limits:

- Nix asks the user to accept these settings, unless `accept-flake-config` is
  set.
- Nix only applies them to the flake given on the command line. They don't apply
  when another flake uses yours as an input.
- If the daemon doesn't trust the user, Nix only applies them to caches and keys
  that the daemon already trusts.

So `nixConfig` is useful for your own builds of the flake, but it won't set up
the cache for your flake's users.

## Checking it works

Ask the cache for its basic information:

```sh
curl -fsS https://cupboard.example.workers.dev/t/acme/nix-cache-info
```

```
StoreDir: /nix/store
WantMassQuery: 1
Priority: 40
```

Nix tries substituters in order of priority, lowest number first.
cache.nixos.org also uses 40. The tenant administrator can change a cache's
priority.

Next, build something that you know the cache has, using
`nix build --print-build-logs`. Check that Nix downloads it rather than building
it. If Nix builds it, see [Troubleshooting](../troubleshooting.md#nix-clients).

## Which versions of Nix work

cupboard compresses the files that it serves with zstd, so you need a version of
Nix that can decompress zstd. cupboard is tested with Nix 2.34. Older versions
of Nix, and other Nix implementations, aren't tested.
