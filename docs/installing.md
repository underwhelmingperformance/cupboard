# Installing the CLI

This page explains how to install the `cupboard` CLI, with Nix or from a release
archive.

You need the CLI if you deploy or operate a deployment, administer a tenant, or
push store paths from your own machine. You don't need it just to read from a
cache with Nix. CI jobs that use cupboard's GitHub Actions install it for
themselves.

The CLI runs on Linux and macOS, on both x86-64 and arm64.

## Installing with Nix

cupboard's flake builds the CLI from source. To install a release into your
profile:

```sh
nix profile add github:underwhelmingperformance/cupboard/vX.Y.Z
```

To run it once without installing it:

```sh
nix run github:underwhelmingperformance/cupboard/vX.Y.Z -- --help
```

If you leave out the tag, Nix builds the latest commit on `main`.

When you run `cupboard --version`, a build made with Nix prints the commit that
it was built from.

### Using cupboard in your own flake

To use cupboard in a flake of your own, add it as an input and use its package.
For example, to add it to a NixOS system:

```nix
{
  inputs.cupboard.url = "https://flakehub.com/f/underwhelmingperformance/cupboard/*";

  outputs = { nixpkgs, cupboard, ... }: {
    nixosConfigurations.example = nixpkgs.lib.nixosSystem {
      modules = [
        ({ pkgs, ... }: {
          environment.systemPackages = [
            cupboard.packages.${pkgs.stdenv.hostPlatform.system}.default
          ];
        })
      ];
    };
  };
}
```

The flake also has an overlay, `cupboard.overlays.default`, which provides
`pkgs.cupboard`. The overlay builds cupboard with your own nixpkgs, so Nix can't
substitute it from the release cache described below. Your nixpkgs must be
recent enough to include Node.js 24 and pnpm 10.

The overlay deliberately uses pnpm 10, not the pnpm 12 that the repository pins
for development. nixpkgs doesn't package pnpm 12, and pnpm 10 can read the
lockfile that pnpm 12 writes. The build only uses pnpm to fetch packages and
install them from the lockfile.

### Following releases

Every release is published to [FlakeHub](https://flakehub.com). If you use a
FlakeHub URL with a version range, your input follows releases rather than
commits. For example:

- `.../cupboard/*` follows the newest release.
- `.../cupboard/0.0.*` follows the 0.0.x releases.

Nix resolves the range when it locks the input. Your `flake.lock` keeps you on
that release until you run `nix flake update`, which moves you to the newest
release in the range.

If you'd rather choose versions yourself, pin a tag instead:
`github:underwhelmingperformance/cupboard/v1.2.3`.

### Substituting release builds

Each release's flake package is also published to a public cupboard cache. If
you add the cache to your Nix configuration, Nix can download the CLI instead of
building it:

```
extra-substituters = https://cupboard.supply/t/cupboard/cache/releases
extra-trusted-public-keys = cupboard-1:tiaTSFvY6LqLUwbjsNcig64LnxZ+T5EQgW5Cr4XjXqU=
```

The same lines appear in each release's notes.
[Using a cache](./use/nix-clients.md) explains where to put them. The key's name
doesn't follow cupboard's current naming scheme because it was created before
that scheme existed.

## Installing from a release

Each
[GitHub release](https://github.com/underwhelmingperformance/cupboard/releases)
has one archive for each platform:

- `cupboard-linux-x64.tar.gz`
- `cupboard-linux-arm64.tar.gz`
- `cupboard-macos-x64.tar.gz`
- `cupboard-macos-arm64.tar.gz`

The release also has a `checksums.txt` file, and GitHub artifact attestations
for the archives and the checksums.

To install on Linux x86-64:

1. Download the archive and the checksums:

   ```sh
   gh release download vX.Y.Z --repo underwhelmingperformance/cupboard \
     --pattern cupboard-linux-x64.tar.gz --pattern checksums.txt
   ```

2. Check the archive against the checksums:

   ```sh
   sha256sum --check --ignore-missing checksums.txt
   ```

3. Verify the archive's attestation:

   ```sh
   gh attestation verify cupboard-linux-x64.tar.gz \
     --repo underwhelmingperformance/cupboard
   ```

4. Unpack it:

   ```sh
   tar -xzf cupboard-linux-x64.tar.gz
   ```

On macOS, use `shasum` to check the archive that you downloaded:

```sh
grep cupboard-macos-arm64.tar.gz checksums.txt | shasum -a 256 --check
```

The archive contains two files, `cupboard` and a helper called
`cupboard-hook-relay`, and unpacks them into the current directory. Keep the two
files in the same directory. `cupboard build-push` expects to find the helper
next to the `cupboard` executable. You can still put a symbolic link to
`cupboard` somewhere else on your `PATH`.

## Checking the installation

To check that the CLI works:

```sh
cupboard --version
cupboard --help
```

[The CLI reference](./reference/cli.md) lists every command. Most commands need
you to sign in first. See [Signing in](./admin/signing-in.md).
