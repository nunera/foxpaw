self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.foxpaw;
  inherit (lib) mkEnableOption mkIf mkOption types;
in
{
  options.programs.foxpaw = {
    enable = mkEnableOption "foxpaw, which lets AI agents and programs drive Zen or Firefox over WebDriver BiDi";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "foxpaw.packages.\${system}.default";
      description = "The foxpaw package.";
    };

    browser = mkOption {
      type = types.nullOr (types.either types.package types.str);
      default = null;
      example = lib.literalExpression "config.programs.zen-browser.finalPackage";
      description = ''
        Browser `foxpaw launch` starts (FIREFOX_BIDI_BROWSER): a package (its main program) or an executable path.
        Unset, foxpaw takes the first Zen or Firefox on PATH.
      '';
    };

    profile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        Profile directory `foxpaw launch` uses (FIREFOX_BIDI_PROFILE). Unset, foxpaw keeps its own profile in
        $XDG_DATA_HOME/foxpaw/profile, next to your everyday one, and you sign in there once.
      '';
    };

    dynamic = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Start remote control from inside the browser instead of with --remote-debugging-port, so pages don't see
        navigator.webdriver = true (FIREFOX_BIDI_LAUNCH=dynamic). The browser needs foxpaw's AutoConfig:
        `pkgs.firefox.override foxpaw.lib.wrapFirefoxArgs`, or `overrideAttrs foxpaw.lib.withRemoteControl` on a
        prebuilt unwrapped browser.
      '';
    };

    autoLaunch = mkOption {
      type = types.bool;
      default = false;
      description = "Let the broker start the browser when an agent or program needs one and none is running (FIREFOX_BIDI_AUTO_LAUNCH=1).";
    };

    omp.enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Install the `zen_browser` tool for oh-my-pi as ~/.omp/agent/extensions/foxpaw.ts. Remove any other copy of
        the extension (an older zen-browser.ts symlink, `omp plugin` installs) so the tool registers once.
      '';
    };
  };

  config = mkIf cfg.enable {
    home.packages = [ cfg.package ];

    home.sessionVariables = lib.filterAttrs (_: value: value != null) {
      FIREFOX_BIDI_BROWSER =
        if cfg.browser == null then null
        else if lib.isDerivation cfg.browser then lib.getExe cfg.browser
        else cfg.browser;
      FIREFOX_BIDI_PROFILE = cfg.profile;
      FIREFOX_BIDI_LAUNCH = if cfg.dynamic then "dynamic" else null;
      FIREFOX_BIDI_AUTO_LAUNCH = if cfg.autoLaunch then "1" else null;
    };

    home.file.".omp/agent/extensions/foxpaw.ts" = mkIf cfg.omp.enable {
      source = "${cfg.package}/lib/foxpaw/extension/zen-browser.ts";
    };
  };
}
