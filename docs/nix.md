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

The flake builds the CLI from source for the host platform (x86-64 and arm64
Linux, arm64 macOS), so pinning the input at a revision gives you the `cupboard`
built from that same revision, and the package version reflects it. The flake
also exposes an overlay, so you can refer to `pkgs.cupboard` after adding
`inputs.cupboard.overlays.default` to your `nixpkgs.overlays`.

## Tracking releases

Every release is published to [FlakeHub], and that is the way to follow
versioned releases rather than individual commits. Point the input at FlakeHub
with a version range:

```nix
inputs.cupboard.url = "https://flakehub.com/f/underwhelmingperformance/cupboard/*";
```

`*` follows the newest release; a range such as `0.1.*` allows patch and minor
movement only. FlakeHub resolves the range when the input is locked, so
`nix flake update` is what moves you to a newer release, and `flake.lock` pins
the exact release you got until the next update.

Each release's GitHub notes include the `nix.conf` lines for a binary cache that
serves that release's builds, so moving to a new release does not mean building
it from source. Alternatively pin a tag directly
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

### As a NixOS or home-manager module

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

home-manager is identical, importing
`inputs.cupboard.homeManagerModules.default` instead. A user-level substituter
only takes effect if the user is a trusted user of the daemon
(`nix.settings.trusted-users`); otherwise set it system-wide.

### Straight into nix.conf

For a machine you manage by hand, append the snippet:

```sh
cupboard config "$url" "$(cupboard pubkey "$url")" | sudo tee -a /etc/nix/nix.conf
```

## Private caches

A private cache needs credentials, which Nix reads from a netrc file rather than
from `nix.conf` or `nixConfig`. `cupboard config` prints the netrc line when
given read credentials:

```sh
cupboard config "$url" "$(cupboard pubkey "$url")" \
  --read-user "$user" --read-password "$password"
```

Point Nix at the file with `nix.settings.netrc-file` (or `netrc-file` in
`nix.conf`). Keep the credentials out of the Nix store; reference a path managed
outside it, such as one provided by a secrets tool.
