# Nix helpers for starting remote control without --remote-debugging-port (`foxpaw launch --dynamic`), which keeps
# navigator.webdriver false. Both install foxpaw's AutoConfig; it starts remote control only in a browser started
# with FOXPAW_REMOTE_CONTROL=1, so every other start of the browser stays as it was.
let
  text = builtins.readFile ../autoconfig/foxpaw.cfg;
  # wrapFirefox pastes extraPrefs into an unquoted heredoc, where these would be expanded by the shell.
  cfg =
    if builtins.length (builtins.split "[`$\\]" text) > 1
    then throw "autoconfig/foxpaw.cfg must not contain dollar signs, backticks or backslashes"
    else text;
in
{
  autoconfig = ../autoconfig;

  # For browsers built with nixpkgs' wrapFirefox (pkgs.firefox, firefox-esr, firefox-beta, librewolf, …):
  #   pkgs.firefox.override foxpaw.lib.wrapFirefoxArgs
  # The wrapper copies the browser binary next to its own mozilla.cfg, so no browser rebuild happens. If you already
  # pass extraPrefs or extraAutoConfig, concatenate them with these.
  wrapFirefoxArgs = {
    extraAutoConfig = ''pref("general.config.sandbox_enabled", false);'';
    extraPrefs = cfg;
  };

  # For a prebuilt *unwrapped* browser whose wrapper does not read wrapFirefox's mozilla.cfg, such as the Zen flake
  # (github:0xc000022070/zen-browser-flake):
  #   zen.twilight-unwrapped.overrideAttrs foxpaw.lib.withRemoteControl
  # It copies the AutoConfig into the install directory (the one with omni.ja and browser/), so only repackaging
  # happens. Don't use it on firefox-unwrapped from nixpkgs: that rebuilds Firefox from source; use wrapFirefoxArgs.
  withRemoteControl = old: {
    postInstall = (old.postInstall or "") + ''
      foxpawAppDir=""
      while IFS= read -r ja; do
        if [ -d "$(dirname "$ja")/browser" ]; then foxpawAppDir="$(dirname "$ja")"; break; fi
      done < <(find -L "$out" -name omni.ja -not -path '*/browser/*')
      if [ -z "$foxpawAppDir" ]; then echo "foxpaw: no browser install directory (omni.ja next to browser/) in $out" >&2; exit 1; fi
      if grep -ls 'general.config.filename' "$foxpawAppDir"/defaults/pref/*.js | grep -v foxpaw-autoconfig.js; then
        echo "foxpaw: $foxpawAppDir already names an AutoConfig file; a browser reads only one" >&2; exit 1
      fi
      chmod u+w "$foxpawAppDir" "$foxpawAppDir/defaults" "$foxpawAppDir/defaults/pref"
      install -m644 ${../autoconfig/foxpaw.cfg} "$foxpawAppDir/foxpaw.cfg"
      install -m644 ${../autoconfig/defaults/pref/foxpaw-autoconfig.js} "$foxpawAppDir/defaults/pref/foxpaw-autoconfig.js"
    '';
  };
}
