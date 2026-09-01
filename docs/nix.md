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

Both modules expose `nix.cupboard.caches`, a list of caches, and fold each entry
into `nix.settings.substituters` and `nix.settings.trusted-public-keys`. The
default cache and its key are kept; the caches you list are added.

A public cache sets `url`. A private cache sets `substitutersFile` instead: its
substituter URL carries a read credential, and `nix.conf` is world-readable, so
the module never writes that URL into it. See [Private caches][cache-access].

[cache-access]: #private-caches

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

Create a private cache, then push to its stable cache URL:

```sh
cupboard cache create "$url" release --access private
cupboard push "$url/cache/release" ./result
```

A reader needs the cache's substituter settings and a credential, which the next
section configures.

### Configuring a client

`cupboard config` takes cache names as positional arguments. It prints one
snippet for all selected caches, in argument order. Omit the names when the URL
already selects one cache, including the default cache at the bare tenant URL:

```sh
credentials=$(printf '[{"cache":{"kind":"named","name":"release"},"credential":{"user":"%s","password":"%s"}}]' "$user" "$password")

CUPBOARD_CACHE_CREDENTIALS=$credentials \
  cupboard config "$url" "$(cupboard pubkey "$url")" \
    builds release
```

Write the complete snippet to the destination file. The credentials are a JSON
array whose entries pair an explicit cache scope with its `user` and `password`.
Supply it in `CUPBOARD_CACHE_CREDENTIALS` or `--cache-credentials`. The option
takes precedence when both are set.

The environment variable keeps the credential out of the process arguments,
which other users of the machine can read. The composite action takes the same
document in its `cache-credentials` input.

A private cache without its own entry uses `--read-user` and `--read-password`,
which specify the tenant-wide fallback credential. Every cache-specific entry
must match a selected cache.

### Keeping the credential out of `nix.conf`

A netrc entry is keyed only by host, so netrc cannot provide different
credentials to several caches on the same host. Each cache-specific credential
therefore appears as userinfo in that cache's stable URL. Nix fetches through
curl, which prefers a credential in a URL to a netrc entry for the same host.
Netrc can therefore provide the tenant-wide fallback credential while each
private cache's URL provides its own credential.

The generated snippet contains these URLs, so protect it as you would protect
the credentials. Give the snippet to the modules through `substitutersFile`:

```nix
{
  nix.cupboard.caches = [
    {
      url = "https://cupboard.example.workers.dev/t/acme/cache/builds";
      publicKeys = [ "cupboard-1:abc123..." ];
    }
    {
      substitutersFile = "/etc/nix/cupboard-release.conf";
      publicKeys = [ "cupboard-1:abc123..." ];
    }
  ];
}
```

Set `substitutersFile` to a file that contains the `extra-substituters` line
printed by `cupboard config`. Create the file outside the Nix store with mode
0400 or 0600, and make it readable only by the account that runs Nix. The option
has type `lib.types.externalPath`, so module evaluation rejects a path in the
Nix store.

The module writes a required `include` directive to `nix.conf`. Nix reads the
protected file at runtime, so the credential-bearing URL does not appear in the
world-readable `nix.conf`. Settings in the included file extend the settings
that Nix has already read, which adds the private cache to the other
substituters. If the file is missing or unreadable, Nix rejects the
configuration. The private cache therefore cannot disappear from the substituter
list without an error.

### Cache access

A named cache is always read at `/t/<tenant>/cache/<name>/`, and the tenant's
default cache uses the bare tenant URL. Its `access` property is either `public`
or `private`. A private cache requires HTTP Basic authentication on the same
stable URL and sends `cache-control: no-store`; changing access does not create
a second cache or move its contents.

Commands accept the stable cache URL directly. A command that also takes local
paths can instead use the bare tenant URL followed by a cache name. A bare
tenant URL without a cache name selects the default cache.

### The tenant-wide fallback credential

One credential can cover every private cache that does not have a credential of
its own. Nix reads this tenant-wide fallback credential from a netrc file.
`cupboard config` prints the netrc line when given read credentials:

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
an environment variable or a recipient may still retain a copy. When a cache has
its own credential, only that credential authenticates reads of the cache.
Giving a cache its own credential does not widen the access granted by another
credential.

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
`/t/<tenant>/cache/<name>/nar/<hash>.nar.zst` only when that cache has a path
that references the hash. A private cache's own credential authorises only reads
through that cache. The public routes serve no NAR referenced only by private
caches. Knowing the hash does not bypass these checks. Deleting the last path
that references a NAR in a cache stops that cache serving the NAR before the
deletion reports success.

All of a tenant's public caches share one authorisation range. A reader admitted
to one public cache can address every other public cache. A NAR referenced by
any public cache is served from every public prefix of the tenant, including
`/t/<tenant>/nar/<hash>.nar.zst`.

Publishing a NAR hash does not bypass cache authorisation. It does disclose that
the path exists and identifies its contents to anyone holding a copy from
elsewhere. The in-toto subject digest of a cupboard attestation is the NAR hash.
A public transparency log exposes that digest to everyone, and a repository's
attestation store exposes it to every reader of that repository. Both are
append-only, so a published NAR hash cannot be withdrawn.

### Attesting to a private cache

`actions/attest` derives its defaults from the destination cache's visibility. A
private destination signs in the public-good trust domain with an RFC 3161
timestamp and no transparency-log entry. It does not record the bundle in the
repository's attestation store, and it signs a separate statement for each
subject. Each bundle contains one subject. A public destination uses the
Sigstore instance selected for the repository's visibility, records the bundle
in the repository's attestation store, and signs one statement for the whole
run.

Explicit inputs override these defaults and set the action's disclosure policy.
Before signing, the action prints the services it will contact and every
location where it will publish the complete bundle.

Verifying a bundle that carries no transparency-log entry requires
`--tlog-threshold 0`; `cupboard attest verify --help` prints the complete
command. [The GitHub Actions guide][github-actions] covers the action's inputs.

[github-actions]: ./github-actions.md
