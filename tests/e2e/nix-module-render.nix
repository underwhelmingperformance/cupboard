# Evaluates the flake's NixOS or Home Manager module with `lib.evalModules` and
# renders the resulting `nix.conf` in the order that NixOS or Home Manager
# writes it. The test passes its input as JSON in `CUPBOARD_NIX_MODULE_INPUT`,
# so no value is parsed as Nix source.
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
  isNixos = input.module == "nixos";

  # Only the options that the module, the NixOS defaults and the user's
  # configuration set.
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

  # The user's own caches, either as bare settings or as bare lines in the
  # user's own `extraOptions`.
  userModules = {
    none = { };
    settings = {
      nix.settings.substituters = [ input.user.url ];
      nix.settings.trusted-public-keys = [ input.user.key ];
    };
    extraOptions = {
      nix.extraOptions = ''
        substituters = ${input.user.url}
        trusted-public-keys = ${input.user.key}
      '';
    };
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

  # A user's configuration imports the cupboard module and then sets its own
  # options, as a `configuration.nix` or `home.nix` does. With definitions of
  # equal priority, the module system places the importing module's lines after
  # the imported module's, so the module's `mkAfter` is what keeps its lines
  # last.
  evaluated = lib.evalModules {
    modules = [
      (
        userModules.${input.user.configuration}
        // {
          imports = [
            (if isNixos then flake.nixosModules.default else flake.homeManagerModules.default)
            options
            caches
          ]
          ++ lib.optional isNixos nixosDefaults;
        }
      )
    ];
  };
  inherit (evaluated.config) nix;

  # nixpkgs' `formats.nixConf` writes the `extra-` settings after the others.
  # Home Manager's `modules/misc/nix/default.nix` writes every setting in attribute
  # order. Both append `nix.extraOptions` after the settings.
  names = builtins.attrNames nix.settings;
  nixosNames = lib.partition (name: !lib.hasPrefix "extra-" name) names;
  line = name: "${name} = ${lib.concatStringsSep " " nix.settings.${name}}\n";
in
lib.concatMapStrings line (if isNixos then nixosNames.right ++ nixosNames.wrong else names)
+ nix.extraOptions
