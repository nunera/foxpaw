{
  lib,
  stdenvNoCC,
  makeWrapper,
  bun,
  version,
  src,
}:

# foxpaw has no runtime dependencies besides Bun, so the package is the source tree plus a wrapper; nothing is
# fetched at build time.
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
    # The omp extension must load from the store: every relative import resolves.
    ${lib.getExe bun} build $out/lib/foxpaw/extension/zen-browser.ts --target bun \
      --external @oh-my-pi/pi-coding-agent --outfile $TMPDIR/extension.js > /dev/null
    runHook postInstallCheck
  '';

  meta = {
    description = "Let AI agents and programs drive Zen or Firefox over WebDriver BiDi";
    homepage = "https://github.com/nunera/foxpaw";
    license = lib.licenses.mit;
    mainProgram = "foxpaw";
    platforms = bun.meta.platforms;
  };
}
