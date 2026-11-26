{
  lib,
  stdenvNoCC,
  makeWrapper,
  bun,
  cacert,
  version,
  src,
}:

let
  # Runtime dependencies (ws, zod) exactly as bun.lock pins them. A fixed-output derivation may use the network; its
  # hash pins the result. After changing dependencies or bun.lock, set outputHash to lib.fakeHash, build, and copy the
  # hash Nix reports.
  nodeModules = stdenvNoCC.mkDerivation {
    pname = "foxpaw-node-modules";
    inherit version;

    src = lib.fileset.toSource {
      root = src;
      fileset = lib.fileset.unions [
        (src + /package.json)
        (src + /bun.lock)
      ];
    };

    nativeBuildInputs = [ bun ];
    dontConfigure = true;
    dontFixup = true;

    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      export SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt
      bun install --frozen-lockfile --production --ignore-scripts --no-progress --backend=copyfile
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      rm -rf node_modules/.cache
      cp -r node_modules $out
      runHook postInstall
    '';

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-sv5Kn009tRhfT1l9WqrTR6JrNnwoAeEWyd85fPxUEQ4=";
  };
in
stdenvNoCC.mkDerivation {
  pname = "foxpaw";
  inherit version;

  src = lib.fileset.toSource {
    root = src;
    fileset = lib.fileset.unions [
      (src + /src)
      (src + /extension)
      (src + /autoconfig)
      (src + /package.json)
      (src + /README.md)
      (src + /LICENSE)
    ];
  };

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/foxpaw $out/bin
    cp -r src extension autoconfig package.json README.md LICENSE $out/lib/foxpaw/
    ln -s ${nodeModules} $out/lib/foxpaw/node_modules
    # bun on PATH: the CLI and the omp extension start the broker with it.
    makeWrapper ${lib.getExe bun} $out/bin/foxpaw \
      --add-flags $out/lib/foxpaw/src/cli.ts \
      --prefix PATH : ${lib.makeBinPath [ bun ]}
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME=$TMPDIR
    $out/bin/foxpaw help | grep -q 'foxpaw launch\|launch \['
    $out/bin/foxpaw autoconfig print | grep -q FOXPAW_REMOTE_CONTROL
    # The omp extension must load from the store: every import, relative or from node_modules, resolves.
    ${lib.getExe bun} build $out/lib/foxpaw/extension/zen-browser.ts --target bun \
      --external @oh-my-pi/pi-coding-agent --outfile $TMPDIR/extension.js > /dev/null
    runHook postInstallCheck
  '';

  passthru = { inherit nodeModules; };

  meta = {
    description = "Let AI agents and programs drive Zen or Firefox over WebDriver BiDi";
    homepage = "https://github.com/nunera/foxpaw";
    license = lib.licenses.mit;
    mainProgram = "foxpaw";
    platforms = bun.meta.platforms;
  };
}
