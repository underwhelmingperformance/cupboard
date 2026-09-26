# Evaluates the flake's cupboard module with `lib.evalModules` and renders the
# resulting `nix.conf` in the order that NixOS writes it. The test passes its
# input as JSON in `CUPBOARD_NIX_MODULE_INPUT`, so no value is parsed as Nix
# source.
let
  input = builtins.fromJSON (builtins.getEnv "CUPBOARD_NIX_MODULE_INPUT");
  root = /. + input.root;
  lock = builtins.fromJSON (builtins.readFile (root + "/flake.lock"));
  lib = import "${builtins.fetchTree lock.nodes.nixpkgs.locked}/lib";
  flake = (import (root + "/flake.nix")).outputs {
    self = { };
    nixpkgs = { inherit lib; };
    nixpkgs-x86_64-darwin = { };
  };

  # Only the options that the module and the NixOS defaults below set.
  options = {
    options.assertions = lib.mkOption {
      type = lib.types.listOf lib.types.unspecified;
      default = [ ];
    };
    options.nix.settings = lib.mkOption {
      type = lib.types.attrsOf (lib.types.listOf lib.types.str);
      default = { };
    };
    options.nix.extraOptions = lib.mkOption {
      type = lib.types.lines;
      default = "";
    };
  };

  # NixOS sets its default cache in `nixos/modules/config/nix.nix` this way.
  nixosDefaults = {
    nix.settings.substituters = lib.mkAfter [ input.system.url ];
    nix.settings.trusted-public-keys = [ input.system.key ];
  };

  caches = {
    nix.cupboard.caches = [
      {
        url = input.cupboard.url;
        publicKeys = [ input.cupboard.key ];
      }
      {
        inherit (input) substitutersFile;
        publicKeys = [ input.cupboard.privateKey ];
      }
    ];
  };

  evaluated = lib.evalModules {
    modules = [
      flake.nixosModules.default
      options
      nixosDefaults
      caches
    ];
  };
  inherit (evaluated.config) nix;

  # nixpkgs' `formats.nixConf` writes the `extra-` settings after the others,
  # and NixOS appends `nix.extraOptions` after all settings.
  names = lib.partition (name: !lib.hasPrefix "extra-" name) (builtins.attrNames nix.settings);
  line = name: "${name} = ${lib.concatStringsSep " " nix.settings.${name}}\n";
in
lib.concatMapStrings line (names.right ++ names.wrong) + nix.extraOptions
