{
  description = "foxpaw: let AI agents and programs drive Zen or Firefox over WebDriver BiDi";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
      mkFoxpaw = pkgs: pkgs.callPackage ./nix/package.nix { inherit version; src = ./.; };
    in
    {
      packages = forAllSystems (pkgs: rec {
        foxpaw = mkFoxpaw pkgs;
        default = foxpaw;
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
          meta.description = "foxpaw CLI";
        };
      });

      overlays.default = final: _prev: { foxpaw = mkFoxpaw final; };

      lib = import ./nix/lib.nix;

      homeModules.default = import ./nix/home-manager.nix self;

      checks = forAllSystems (pkgs: { foxpaw = self.packages.${pkgs.stdenv.hostPlatform.system}.default; } // nixpkgs.lib.optionalAttrs (pkgs.stdenv.hostPlatform.system == "x86_64-linux") { vm = import ./nix/tests/vm.nix { inherit pkgs; foxpaw = self.packages.x86_64-linux.foxpaw; src = ./.; }; });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.bun pkgs.nodejs_22 pkgs.typescript ]; };
      });
    };
}
