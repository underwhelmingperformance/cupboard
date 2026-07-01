{
  description = "cupboard: a multi-tenant Nix binary cache on Cloudflare Workers";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      # The package is built from this flake's own source, so its version is the
      # revision it was built from. A pinned input therefore yields the matching
      # cupboard. `dirtyShortRev` covers building from an uncommitted worktree.
      version = self.shortRev or self.dirtyShortRev or "dev";

      # SRI hash of the fetched pnpm store, per system: the store carries the
      # platform's esbuild binary, so it differs across systems. After a
      # `pnpm-lock.yaml` change set the relevant entry to lib.fakeHash, build,
      # and copy the hash Nix reports back into place.
      pnpmDepsHash = {
        x86_64-linux = nixpkgs.lib.fakeHash;
        aarch64-linux = nixpkgs.lib.fakeHash;
        x86_64-darwin = nixpkgs.lib.fakeHash;
        aarch64-darwin = nixpkgs.lib.fakeHash;
      };

      # `pnpm build:binary` bundles the CLI and both Workers, then injects the
      # bundle into a copy of the Node binary as a single executable. The build
      # reads the version from CUPBOARD_BUILD_VERSION rather than Git, since the
      # flake source has no checkout. Darwin needs an ad-hoc codesign for the
      # rewritten Mach-O to run; sigtool provides it.
      mkCupboard =
        pkgs:
        let
          inherit (pkgs) lib stdenv;
          nodejs = pkgs.nodejs_24;
        in
        stdenv.mkDerivation (finalAttrs: {
          pname = "cupboard";
          inherit version;
          src = self;

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            pnpm = pkgs.pnpm;
            fetcherVersion = 3;
            hash = pnpmDepsHash.${stdenv.hostPlatform.system};
          };

          nativeBuildInputs = [
            nodejs
            pkgs.pnpm
            pkgs.pnpmConfigHook
          ] ++ lib.optional stdenv.isDarwin pkgs.darwin.sigtool;

          env.CUPBOARD_BUILD_VERSION = version;

          buildPhase = ''
            runHook preBuild
            pnpm build:binary -- --version "${version}" --out-dir dist/release
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            install -Dm755 dist/release/package/cupboard "$out/bin/cupboard"
            runHook postInstall
          '';

          meta = {
            description = "CLI for the cupboard Nix binary cache";
            homepage = "https://github.com/underwhelmingperformance/cupboard";
            license = lib.licenses.agpl3Plus;
            mainProgram = "cupboard";
            platforms = systems;
            sourceProvenance = [ lib.sourceTypes.fromSource ];
          };
        });

      # A cache to substitute from: the tenant or named-cache URL that `cupboard
      # config` prints, and the public key(s) from `cupboard pubkey`.
      cacheType =
        lib:
        lib.types.submodule {
          options = {
            url = lib.mkOption {
              type = lib.types.str;
              example = "https://cupboard.example.workers.dev/t/acme";
              description = "Substituter URL, as printed by `cupboard config`.";
            };

            publicKeys = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              example = [ "cupboard-1:abc123..." ];
              description = "Trusted public key(s), as printed by `cupboard pubkey`.";
            };
          };
        };

      # The substituter half of a Nix module, shared by the NixOS and
      # home-manager modules: both expose `nix.cupboard.caches` and fold it into
      # the relevant `nix.settings`. List settings merge by concatenation, so
      # cache.nixos.org and its key are kept alongside these.
      cupboardModule =
        { config, lib, ... }:
        let
          cfg = config.nix.cupboard;
        in
        {
          options.nix.cupboard.caches = lib.mkOption {
            type = lib.types.listOf (cacheType lib);
            default = [ ];
            description = "cupboard caches to add as Nix substituters.";
          };

          config = lib.mkIf (cfg.caches != [ ]) {
            nix.settings = {
              substituters = map (cache: cache.url) cfg.caches;
              trusted-public-keys = lib.concatMap (cache: cache.publicKeys) cfg.caches;
            };
          };
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          cupboard = mkCupboard nixpkgs.legacyPackages.${system};
        in
        {
          inherit cupboard;
          default = cupboard;
        }
      );

      apps = forAllSystems (system: rec {
        cupboard = {
          type = "app";
          program = "${self.packages.${system}.cupboard}/bin/cupboard";
        };
        default = cupboard;
      });

      overlays.default = _final: prev: { cupboard = mkCupboard prev; };

      nixosModules.default = cupboardModule;
      homeManagerModules.default = cupboardModule;

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
