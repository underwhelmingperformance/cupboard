{
  description = "cupboard: a multi-tenant Nix binary cache on Cloudflare Workers";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  # Nixpkgs 26.11 dropped Intel macOS. Keep the final supported branch as a
  # narrow compatibility input so a workflow pinned to Cupboard source can
  # still acquire the same platforms as a published release.
  inputs.nixpkgs-x86_64-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-x86_64-darwin,
    }:
    let
      systems = map (entry: entry.system) (nixpkgs.lib.importJSON ./packages/nix/src/nix-systems.json);
      forAllSystems = nixpkgs.lib.genAttrs systems;
      packageSets = forAllSystems (
        system:
        if system == "x86_64-darwin" then
          nixpkgs-x86_64-darwin.legacyPackages.${system}
        else
          nixpkgs.legacyPackages.${system}
      );

      # The package is built from this flake's own source, so its version is the
      # revision it was built from. A pinned input therefore yields the matching
      # cupboard. `dirtyShortRev` covers building from an uncommitted worktree.
      version = self.shortRev or self.dirtyShortRev or "dev";

      # SRI hash of the fetched pnpm store. The fetcher downloads every
      # platform's binaries, so the store and its hash are identical on all
      # systems. The file pairs the hash with a digest of the lockfile it was
      # resolved from: `pnpm update:flake-deps` refreshes the pair after a
      # `pnpm-lock.yaml` change, and `pnpm check:flake-deps` fails when they
      # drift apart.
      pnpmDepsHashes = nixpkgs.lib.importJSON ./pnpm-deps-hash.json;
      pnpmDepsHash =
        if (pnpmDepsHashes.confirmation or null) == "pending" then
          throw "pnpm-deps-hash.json contains an unconfirmed store hash"
        else
          pnpmDepsHashes.store;

      # `pnpm build:binary` bundles the CLI and both Workers, then injects the
      # bundle into a copy of the Node binary as a single executable. It also
      # compiles the post-build hook helper with the stdenv toolchain (the
      # sandbox's `CC`); install places it under `libexec/cupboard/`, where the
      # CLI's helper resolution looks relative to `bin/cupboard`. The build
      # reads the version from CUPBOARD_BUILD_VERSION rather than Git, since the
      # flake source has no checkout. Darwin needs an ad-hoc codesign for the
      # rewritten Mach-O to run; sigtool provides it.
      mkCupboard =
        pkgs:
        let
          inherit (pkgs) lib stdenv;
          nodejs = pkgs.nodejs_24;

          # pnpm 11 keeps its store index in a SQLite database it opens through
          # `node:sqlite`, and on darwin that dies with an EXC_GUARD file
          # descriptor violation during install. pnpm 10 has no store database.
          pnpm = pkgs.pnpm_10;
        in
        stdenv.mkDerivation (finalAttrs: {
          pname = "cupboard";
          inherit version;
          src = self;

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            inherit pnpm;
            fetcherVersion = 4;
            hash = pnpmDepsHash;
          };

          nativeBuildInputs = [
            nodejs
            pnpm
            pkgs.pnpmConfigHook
          ]
          ++ lib.optional stdenv.isDarwin pkgs.darwin.sigtool;

          env.CUPBOARD_BUILD_VERSION = version;

          buildPhase = ''
            runHook preBuild
            pnpm build:binary -- --version "${version}" --out-dir dist/release
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            install -Dm755 dist/release/package/cupboard "$out/bin/cupboard"
            install -Dm755 dist/release/package/cupboard-hook-relay \
              "$out/libexec/cupboard/cupboard-hook-relay"
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

      cacheType =
        lib:
        lib.types.submodule {
          options = {
            url = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "https://cupboard.example.workers.dev/t/acme";
              description = ''
                Substituter URL of a public cache, as printed by
                `cupboard config`.
              '';
            };

            substitutersFile = lib.mkOption {
              type = lib.types.nullOr lib.types.externalPath;
              default = null;
              example = "/etc/nix/cupboard-release.conf";
              description = ''
                Set this to a file containing the `extra-substituters` line
                printed by `cupboard config --private-cache`. Create the file
                outside the Nix store with mode 0400 or 0600, and make it
                readable only by the account that runs Nix.

                The module adds an `include` directive to `nix.conf`. The
                credential-bearing URL remains in the permission-controlled
                file. Nix appends settings from the included file, so the
                private cache joins the substituters from public cache entries
                in this list.

                A missing or unreadable included file makes the Nix
                configuration fail.
              '';
            };

            publicKeys = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              example = [ "cupboard-1:abc123..." ];
              description = ''
                Trusted public key(s), as printed by `cupboard pubkey`. A key
                is public data, so it is set here for a private cache too.
              '';
            };
          };
        };

      # Both modules expose `nix.cupboard.caches`. Nix merges these list settings
      # by concatenation, so the configured caches are added to existing
      # substituters and trusted keys.
      cupboardModule =
        { config, lib, ... }:
        let
          cfg = config.nix.cupboard;
          publicCaches = builtins.filter (cache: cache.url != null) cfg.caches;
          privateCaches = builtins.filter (cache: cache.substitutersFile != null) cfg.caches;
        in
        {
          options.nix.cupboard.caches = lib.mkOption {
            type = lib.types.listOf (cacheType lib);
            default = [ ];
            description = ''
              Cupboard caches to add as Nix substituters. Public cache entries
              specify `url`. Private cache entries specify `substitutersFile`
              so the credential remains in a permission-controlled file.
            '';
          };

          config = lib.mkIf (cfg.caches != [ ]) {
            assertions = map (cache: {
              assertion = (cache.url == null) != (cache.substitutersFile == null);
              message = ''
                nix.cupboard.caches: each cache sets either url (public) or
                substitutersFile (private), and not both.
              '';
            }) cfg.caches;

            nix.settings = {
              substituters = map (cache: cache.url) publicCaches;
              trusted-public-keys = lib.concatMap (cache: cache.publicKeys) cfg.caches;
            };

            nix.extraOptions = lib.concatMapStrings (
              cache: "include ${toString cache.substitutersFile}\n"
            ) privateCaches;
          };
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = packageSets.${system};
          cupboard = mkCupboard packageSets.${system};
          conformanceNix = pkgs.nix.out;
        in
        {
          inherit cupboard;
          default = cupboard;

          # The Nix binary that the conformance suite uses as its reference. The
          # `out` output contains `bin/nix`; selecting it limits the build to a
          # single path that the suite can read directly.
          inherit conformanceNix;

          conformanceOracleProbe =
            pkgs.runCommand "cupboard-conformance-oracle-${system}"
              {
                nativeBuildInputs = [ pkgs.nodejs_24 ];
              }
              ''
                mkdir -p "$out"
                node --experimental-transform-types \
                  --disable-warning=ExperimentalWarning \
                  ${./scripts/conformance-oracle-probe.ts} \
                  ${conformanceNix}/bin/nix ${system} > "$out/oracle.json"
              '';
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

      formatter = forAllSystems (system: packageSets.${system}.nixfmt);
    };
}
