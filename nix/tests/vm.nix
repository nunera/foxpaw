# NixOS VM test: the deterministic benchmark (bench/run.ts) against headless Firefox from nixpkgs, with foxpaw's
# package (its src, node_modules, and bun) and the bench fixtures. Everything comes from the store; the VM has no
# network. The suite's results end up in the check's output ($out/results); the check fails if any task failed.
#
#   nix build path:.#checks.x86_64-linux.vm -L
{
  pkgs,
  foxpaw,
  src,
}:

let
  inherit (pkgs) lib;
  benchSrc = lib.fileset.toSource {
    root = src;
    fileset = lib.fileset.unions [
      (lib.fileset.difference (src + /bench) (lib.fileset.maybeMissing (src + /bench/results)))
      # bench/tsconfig.json extends it.
      (src + /tsconfig.json)
    ];
  };
  # foxpaw's installed tree (src, autoconfig, node_modules) with bench/ next to src/, as in the repository.
  benchRoot = pkgs.runCommand "foxpaw-bench-${foxpaw.version}" { } ''
    mkdir -p $out
    cp -r ${foxpaw}/lib/foxpaw/. $out/
    chmod u+w $out
    cp -r ${benchSrc}/bench ${benchSrc}/tsconfig.json $out/
  '';
  bun = lib.getExe pkgs.bun;
  firefox = lib.getExe pkgs.firefox;
in
pkgs.testers.runNixOSTest {
  name = "foxpaw-bench";

  nodes.machine = {
    virtualisation.memorySize = 4096;
    virtualisation.cores = 4;
    environment.systemPackages = [ foxpaw pkgs.firefox ];
    users.users.bench.isNormalUser = true;
  };

  testScript = ''
    machine.wait_for_unit("multi-user.target")
    machine.succeed("${lib.getExe foxpaw} help >&2")
    status, _ = machine.execute(
      "runuser -u bench -- env HOME=/home/bench ${bun} ${benchRoot}/bench/run.ts --browser ${firefox} --out /tmp/results >&2"
    )
    machine.copy_from_machine("/tmp/results", "")
    assert status == 0, f"deterministic suite failed (exit {status}); see the table above and $out/results"
  '';
}
