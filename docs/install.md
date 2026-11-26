# Installing foxpaw

foxpaw ships as an oh-my-pi plugin, a package you install from GitHub that runs on Node 22+ or Bun 1.1+, standalone binaries with Bun built in, and a Nix flake. All of them give you the same `foxpaw` command; the omp plugin also gives you the `zen_browser` tool.

foxpaw isn't on npm yet; releases will be published as `@nunera/foxpaw`. The unscoped name `foxpaw` on npm belongs to an unrelated package, so `npm install foxpaw`, `bun add foxpaw`, `npx foxpaw`, and `omp plugin install foxpaw` install something else. Until the first npm release, install from `github:nunera/foxpaw`.

After installing, check it works:

```sh
foxpaw help
```

## oh-my-pi

```sh
omp plugin install github:nunera/foxpaw
```

omp runs the extension's TypeScript with its own Bun, so this needs nothing else. It doesn't put `foxpaw` on your PATH; install one of the routes below too if you want the command.

## npm and npx (Node 22+)

From GitHub (the package builds `dist/` in its `prepare` script, so Bun must be on PATH):

```sh
npx github:nunera/foxpaw help
```

`npm install -g github:nunera/foxpaw` doesn't work with npm 11: for a global git install whose package has a `prepare` script, npm links the package to a temporary clone it then deletes. Build a tarball and install that instead:

```sh
npm pack github:nunera/foxpaw
npm install -g ./foxpaw-*.tgz
```

## Bun (1.1+)

```sh
bun add -g --trust github:nunera/foxpaw
```

Bun doesn't run a git dependency's `prepare` script unless you trust it; without `--trust`, the `foxpaw` command is missing because `dist/` was never built.

To use a checkout instead: `bun install` (it builds `dist/`), then `bun install -g "$PWD"`, or run it from source with `bun run start -- help`.

## Binaries

Each [GitHub Release](https://github.com/nunera/foxpaw/releases) has one self-contained executable per platform, with Bun inside, and a `SHA256SUMS` file:

| Platform | Asset |
| --- | --- |
| Linux x86-64 | `foxpaw-linux-x64` |
| Linux ARM64 | `foxpaw-linux-arm64` |
| macOS Intel | `foxpaw-darwin-x64` |
| macOS Apple silicon | `foxpaw-darwin-arm64` |
| Windows x86-64 | `foxpaw-windows-x64.exe` |

```sh
version=v0.2.0 asset=foxpaw-linux-x64
curl -fLO "https://github.com/nunera/foxpaw/releases/download/$version/$asset"
curl -fLO "https://github.com/nunera/foxpaw/releases/download/$version/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS   # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
install -m 755 "$asset" ~/.local/bin/foxpaw
```

The binaries are not signed. On macOS, clear the quarantine flag before the first run: `xattr -d com.apple.quarantine ~/.local/bin/foxpaw`. On NixOS the Linux binaries need `programs.nix-ld.enable`; use the flake instead.

To build them yourself: `bun run build:bin` writes all five to `dist/bin/`; `bun run build:bin linux-x64` builds one.

## Nix

```sh
nix run github:nunera/foxpaw -- help       # one-off
nix profile install github:nunera/foxpaw   # into your profile
```

In a flake, add the input and use the package, the overlay (`pkgs.foxpaw`), or the Home Manager module:

```nix
{
  inputs.foxpaw.url = "github:nunera/foxpaw";

  # NixOS or Home Manager package list
  environment.systemPackages = [ inputs.foxpaw.packages.${pkgs.system}.default ];

  # or Home Manager
  imports = [ inputs.foxpaw.homeModules.default ];
  programs.foxpaw.enable = true;
}
```

`foxpaw.lib` has helpers for browsers packaged with Nix; see the README's Nix section.

The package pins its npm dependencies (ws, zod) by hash. After changing dependencies or `bun.lock`, set `outputHash` in `nix/package.nix` to `lib.fakeHash`, run `nix build path:.`, and copy the hash Nix reports.

## Building the npm package

```sh
bun install            # also runs prepare: bundles dist/
bun run build:node     # dist/cli.js, dist/index.js, chunks, and .d.ts declarations
node dist/cli.js help
npm pack               # foxpaw-<version>.tgz
```

The bundle needs `cli.js` in the same directory as the module that starts the broker; `build:node` keeps every output in `dist/`.
