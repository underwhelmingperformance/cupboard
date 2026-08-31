# Installing cupboard with Nix

cupboard ships a flake that provides the `cupboard` CLI as a package and two Nix
modules for adding a tenant or cache as a substituter.

## The CLI package

Run it without installing:

```sh
nix run github:underwhelmingperformance/cupboard -- --help
```

Install it into a profile:

```sh
nix profile install github:underwhelmingperformance/cupboard
```

The flake builds the CLI from source for x86-64 and arm64 Linux and macOS.
Pinning the input at a revision therefore builds `cupboard` from that revision,
and the package version identifies it. The flake also exposes an overlay, so you
can refer to `pkgs.cupboard` after adding `inputs.cupboard.overlays.default` to
your `nixpkgs.overlays`.

## Tracking releases

Every release is published to [FlakeHub], and that is the way to follow
versioned releases rather than individual commits. Point the input at FlakeHub
with a version range:

```nix
inputs.cupboard.url = "https://flakehub.com/f/underwhelmingperformance/cupboard/*";
```

`*` follows the newest release; a range such as `0.1.*` allows patch releases
within version 0.1. FlakeHub resolves the range when the input is locked, so
`nix flake update` is what moves you to a newer release, and `flake.lock` pins
the exact release you got until the next update.

Every release is published to the same Nix binary cache. Each release's GitHub
notes repeat the cache's `nix.conf` lines, so configure them once to substitute
the current release and later releases. Alternatively pin a tag directly
(`github:underwhelmingperformance/cupboard/v1.2.3`) and bump it yourself.

[FlakeHub]: https://flakehub.com

## Using a cache as a substituter

A cupboard cache speaks the standard Nix binary-cache protocol, so any client
can substitute from it once the URL and public key are configured. Get both from
the CLI:

```sh
url="https://cupboard.example.workers.dev/t/acme"
cupboard config "$url" "$(cupboard pubkey "$url")"
```

That prints the `extra-substituters` and `extra-trusted-public-keys` lines for a
`nix.conf`; the `extra-` forms add the cache alongside cache.nixos.org. There
are three ways to apply them.

### In your own flake

A flake's `nixConfig` declares the substituters Nix should use when building
_that_ flake:

```nix
{
  nixConfig = {
    extra-substituters = [ "https://cupboard.example.workers.dev/t/acme" ];
    extra-trusted-public-keys = [ "cupboard-1:abc123..." ];
  };

  # inputs, outputs, ...
}
```

Nix asks the user to accept a flake's `nixConfig` the first time it sees it (or
honours `accept-flake-config = true`). The setting applies only to the flake at
the top of the command. It does **not** propagate to flakes that take yours as
an input, so this configures _your_ builds, not your users'. For a cache you
want every consumer to use, ship one of the modules below or have them add the
cache to their own configuration.

### As a NixOS or Home Manager module

Both modules expose `nix.cupboard.caches`, a list of `{ url; publicKeys; }`, and
fold each entry into `nix.settings.substituters` and
`nix.settings.trusted-public-keys`. The default cache and its key are kept; the
caches you list are added.

NixOS:

```nix
{
  imports = [ inputs.cupboard.nixosModules.default ];

  nix.cupboard.caches = [
    {
      url = "https://cupboard.example.workers.dev/t/acme";
      publicKeys = [ "cupboard-1:abc123..." ];
    }
  ];
}
```

Home Manager is identical, importing
`inputs.cupboard.homeManagerModules.default` instead. A user-level substituter
only takes effect if the user is a trusted user of the daemon
(`nix.settings.trusted-users`); otherwise set it system-wide.

### Straight into nix.conf

For a machine you manage by hand, append the snippet:

```sh
cupboard config "$url" "$(cupboard pubkey "$url")" | sudo tee -a /etc/nix/nix.conf
```

## Private caches

Create a private cache by pushing to it:

```sh
cupboard push "$url" ./result --private-cache release
```

The push creates `release` if it does not exist.

### Public and private namespaces

A cache is private by its address. A public cache is read at
`/t/<tenant>/cache/<name>/`, or at the bare tenant URL for the tenant's default
cache, and a private cache is read at `/t/<tenant>/private-cache/<name>/`, where
every request authenticates with HTTP Basic credentials and every response is
`cache-control: no-store`. The two namespaces are separate: `cache/foo` and
`private-cache/foo` name different caches, which can both exist and hold
different paths. Visibility is part of a cache's identity rather than a setting
on it, so a cache is created public or private and no command turns one into the
other.

Every command that addresses one cache takes `--cache` for a public cache and
`--private-cache` for a private one, and refuses the two together. Commands that
take a cache by its selector, such as `cupboard cache create`, write a private
cache as `_private-<name>`.

### A private tenant

A tenant can also require a credential on its public routes. Every read of a
public cache then authenticates with the tenant's credential, while `/pubkey`
stays open so a client can still fetch the key it has to trust. One credential
covers the whole host, so Nix reads it from a netrc file. `cupboard config`
prints the netrc line when given read credentials:

```sh
cupboard config "$url" "$(cupboard pubkey "$url")" \
  --read-user "$user" --read-password "$password"
```

Point Nix at the file with `nix.settings.netrc-file` (or `netrc-file` in
`nix.conf`). Keep the credentials out of the Nix store; reference a path managed
outside it, such as one provided by a secrets tool.

### One credential per cache

A private cache is read with the tenant's credential unless it has one of its
own. The tenant credential opens every private cache the tenant has, so a cache
shared with a reader who should not see the others needs its own:

```sh
cupboard tenant rotate-cache-credential \
  https://cupboard.example.workers.dev acme release --read-user reader
```

The command generates the password and prints it once. The deployment stores
only a verifier, so cupboard cannot recover the password later. Shell history,
an environment variable or a recipient may still retain a copy. A cache that has
its own credential accepts that credential and no other, the tenant credential
included. Two credentials therefore never open the same cache, and giving a
cache its own credential never widens what a credential already opens.

`cupboard tenant clear-cache-credential` removes a cache's credential, and the
tenant credential reads that cache again afterwards. Both commands address the
deployment host and name the tenant, so they need operator authority. A private
cache with neither its own credential nor a tenant credential refuses every
read.

### What a private cache protects

Every read through a private cache requires a credential the cache accepts. This
applies to its narinfos and to NARs served through its prefix. A narinfo maps a
store-path hash to the NAR that holds the path's contents, and records that
path's references, deriver and signatures. Nix needs the narinfo before it can
ask for any bytes.

The bytes are addressed by their NAR hash. A private cache serves a NAR under
`/t/<tenant>/private-cache/<name>/nar/<hash>.nar.zst` only when that cache has a
path that references the hash. A private cache's own credential authorises only
reads through that cache. The public routes serve no NAR referenced only by
private caches. Knowing the hash does not bypass these checks. Deleting the last
path that references a NAR in a cache stops that cache serving the NAR before
the deletion reports success.

Public caches are the exception to the per-cache rule: none has a credential of
its own, and a reader admitted to one can address every other, so all of a
tenant's public caches share one authorisation range. A NAR that any public
cache references is served from every public prefix of the tenant, including
`/t/<tenant>/nar/<hash>.nar.zst`.

Publishing a NAR hash does not bypass private-cache authorisation. It does
disclose that the path exists and identifies its contents to anyone holding a
copy from elsewhere. The in-toto subject digest of a cupboard attestation is the
NAR hash. A public transparency log exposes that digest to everyone, and a
repository's attestation store exposes it to every reader of that repository.
Both are append-only, so a published NAR hash cannot be withdrawn.
