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

A reader needs the cache's substituter settings and a credential. The next
section configures both.

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

To include the tenant's default cache in the same configuration, add
`--include-default-cache`. The default cache comes first, followed by the named
caches in argument order:

```sh
CUPBOARD_CACHE_CREDENTIALS=$credentials \
  cupboard config "$url" "$(cupboard pubkey "$url")" \
    --include-default-cache builds release
```

A positional `default` selects a named cache called `default`; the flag selects
the tenant's default cache. The setup Action has the same
`include-default-cache` input.

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
0400 or 0600. For the NixOS module, make it readable only by the account that
runs the Nix daemon. For the Home Manager module, make it readable only by your
own account. Restrict only the file itself: every account that reads `nix.conf`
must be able to enter the directories above it, which needs search (execute)
permission on each of them. `/etc/nix` meets this requirement, and so do
`/run/secrets` and `/run/agenix`, which sops-nix and agenix create with
mode 0751. The option has type `lib.types.externalPath`, so module evaluation
rejects a path in the Nix store.

The module writes an `!include` directive to `nix.conf`. Nix reads the protected
file at runtime, so the credential-bearing URL does not appear in the
world-readable `nix.conf`. Settings in the included file extend the settings
that Nix has already read, which adds the private cache to the other
substituters.

If the file is missing, or the account that must read it cannot read it, Nix
leaves the private cache out of its substituters and reports no error. If an
account cannot search every directory above the file, Nix then ignores every
setting in the including `nix.conf` for that account, again without an error.
With the NixOS module, the including file is the system `nix.conf`: an ordinary
user's Nix then runs without the system's substituters, trusted keys and
experimental features. `sudo nix config show` does not show this, because root
can search every directory. As an ordinary user, run
`nix --extra-experimental-features nix-command config show trusted-public-keys`
and check that it lists the cupboard key. The module writes that key into the
same `nix.conf` as the `!include` line, so the key is missing exactly when Nix
ignored the file.

With the NixOS module, run `sudo nix config show substituters` to confirm that
the private cache is present. An ordinary user's output does not list the
private cache. Builds that the daemon runs for that user still use it, unless
the user's Nix client sends its own substituter list. The client sends its own
list when a user-level `nix.conf`, `NIX_CONFIG` or a command-line option such as
`--option substituters` or `--extra-substituters` sets `substituters` or
`extra-substituters`. That list lacks the private cache, because the client
cannot read the file.

With the Home Manager module, run `nix config show substituters` as yourself to
confirm that the private cache is present. The daemon uses the private cache for
your builds only if you are a trusted user, as for any user-level substituter
(see above). Both commands print the cache's credential. Neither Nix nor
cupboard reports a missing or unreadable file, so run the check after you create
or move the file.

### Cache access

A named cache is always read at `/t/<tenant>/cache/<name>/`, and the tenant's
default cache uses the bare tenant URL. Its `access` property is either `public`
or `private`. A private cache requires HTTP Basic authentication on the same
stable URL and sends `cache-control: no-store`; changing access does not create
a second cache or move its contents.

Commands accept the stable cache URL directly. A command that also takes local
paths can instead use the bare tenant URL followed by a cache name. A bare
tenant URL without a cache name selects the default cache. A first positional
that matches an existing file or directory is a local path. Otherwise it is read
as a cache name when a cache of that name exists; pass `./result` or the
`/cache/<name>` URL to remove the ambiguity.

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

A private cache is read with the tenant-wide fallback credential unless it has
one of its own. The fallback credential reads every private cache the tenant
has, so a cache shared with a reader who should not see the others needs a
credential of its own:

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
tenant credential reads that cache again afterwards. Omit the cache name from
either command to address the tenant's default cache. Both commands address the
deployment host and name the tenant, so they need operator authority. A private
cache with neither its own credential nor a tenant credential refuses every
read.

### What a private cache protects

Every read through a private cache requires a credential the cache accepts. This
applies to its narinfos and to the NARs served under its URL. A narinfo maps a
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

A NAR is served under a cache's URL only when that cache holds a path that
references its hash, for a public cache as for a private one. A NAR that two
caches reference is served under both URLs, and the tenant's bare
`/t/<tenant>/nar/<hash>.nar.zst` route serves what the default cache references.

A reuse view can serve NARs referenced by any cache selected by its current
definition whose access matches the view. The view's access determines whether
the reader must authenticate.

Publishing a NAR hash does not bypass cache authorisation. It does disclose that
the path exists and identifies its contents to anyone holding a copy from
elsewhere. The in-toto subject digest of a cupboard attestation is the NAR hash.
Uploading the bundle to GitHub exposes its subjects to repository readers.
GitHub supports deleting attestations, but deletion cannot retract copies
readers already have.

The `rekor-and-tsa` profile sends the signed statement to Rekor. Its public
[DSSE entry][rekor-dsse-entry] records the signature, certificate and statement
hash, without the full statement. Rekor also indexes the subject digests, so
someone who knows a NAR hash can associate it with that entry. The log record
cannot be deleted.

[rekor-dsse-entry]:
  https://github.com/sigstore/rekor/blob/main/pkg/types/dsse/v0.0.1/entry.go

### Attesting to a private cache

`actions/attest` derives its defaults from the destination cache's access. A
private destination signs in the public-good trust domain with an RFC 3161
timestamp and no transparency-log entry. It does not record the bundle in the
repository's attestation store, and it signs a separate statement for each
subject. Each bundle contains one subject. A public destination uses the
Sigstore instance selected for the repository's visibility, records the bundle
in the repository's attestation store, and signs one statement for the whole
run.

Explicit inputs override these defaults and set the action's disclosure policy.
Before signing, the action reports the services it may contact and where it may
publish signature records or bundles.

Verifying a bundle that carries no transparency-log entry requires
`--tlog-threshold 0`; `cupboard attest verify --help` prints the complete
command. [The GitHub Actions guide][github-actions] covers the action's inputs.

[github-actions]: ./github-actions.md
