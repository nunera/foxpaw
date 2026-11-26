<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" width="64%" alt="foxpaw: an orange mouse pointer with four toe beans above its tip, next to the wordmark fox in ink and paw in orange">
  </picture>
</p>

<p align="center">
  An <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a> tool that lets an AI agent use the Zen or Firefox you already have open,<br>
  signed in, over WebDriver BiDi.
</p>

<p align="center">
  <img alt="Zen and Firefox" src="https://img.shields.io/badge/Zen%20%C2%B7%20Firefox-real%20profile-ff7139?style=flat-square&labelColor=141414&logo=firefoxbrowser&logoColor=ff7139">
  <img alt="WebDriver BiDi" src="https://img.shields.io/badge/WebDriver-BiDi-f3f4f0?style=flat-square&labelColor=141414">
  <img alt="Loopback only" src="https://img.shields.io/badge/network-loopback%20only-ff7139?style=flat-square&labelColor=141414">
  <img alt="Bun" src="https://img.shields.io/badge/Bun-1.x-f3f4f0?style=flat-square&labelColor=141414&logo=bun&logoColor=f3f4f0">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-f3f4f0?style=flat-square&labelColor=141414&logo=typescript&logoColor=f3f4f0">
</p>

<p align="center">
  <a href="#why">Why</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#what-the-agent-gets-back">Responses</a> ·
  <a href="#results">Results</a> ·
  <a href="#security">Security</a> ·
  <a href="#install">Install</a> ·
  <a href="#start-a-browser">Start a browser</a> ·
  <a href="#use-it-from-your-own-programs">Programs</a> ·
  <a href="#nix">Nix</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#reference">Reference</a>
</p>

<br>

## Why

Playwright and Selenium start their own clean browser. That's what you want for tests. It's useless when the page the agent needs is behind your login, and getting there again would mean SSO plus a two-factor prompt on your phone.

foxpaw drives a Zen or Firefox that has your logins: one it starts in its own profile next to your everyday browser, so nothing of yours restarts, or your everyday profile itself. The agent works in real tabs, and you can watch it click.

Working in your own browser changes what a mistake costs. If the agent misreads a page in a test browser, you rerun the test. In yours, it might submit a form twice. Most of the code is there so the agent can tell what a click actually did before it decides what to do next.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-it-works-dark.svg">
  <img src="docs/assets/how-it-works-light.svg" width="100%" alt="Three agent sessions connect to the foxpaw broker on 127.0.0.1:9223. The broker holds the one WebDriver BiDi session to your signed-in Zen or Firefox on port 9222, where the agent's pointer clicks Register on a registration page.">
</picture>

Firefox only allows one WebDriver BiDi session at a time, so a small broker holds it and every agent session talks to the broker. Requests run concurrently, and each response goes back to the session that sent it. The broker starts with the first tool call and exits when the last session disconnects.

Programs that speak plain WebDriver BiDi can share the session too: they connect to `ws://127.0.0.1:9223/session` instead of Firefox's port. Each connection gets a session of its own. The broker answers `session.new` and `session.end` itself, and `session.status` reports that connection's view, so a client that checks its session was released still works. Everything else runs on the shared session, with these rules:

- A client only receives events from its own subscriptions, and only for the tabs it named. Events from an iframe count as its tab.
- A request held by a network intercept goes only to the client that added the intercept. A client that fails every held request it doesn't recognize (a submit guard does) would otherwise fail other clients' requests.
- When a client ends its session or disconnects, the broker fails the requests it was still holding, then removes its intercepts, preload scripts and subscriptions. A held request is never let through on a departed client's behalf.

Nothing has to be started by hand: the extension, the CLI, and `foxpaw ensure` start the broker when it isn't running. While it shuts down it turns new clients away, and they start a fresh one.

| Path | What it is |
| --- | --- |
| `extension/zen-browser.ts` | The `zen_browser` tool for oh-my-pi |
| `src/broker.ts` | The loopback broker that shares the BiDi session |
| `src/mux.ts` | Plain WebDriver BiDi on `/session`: one virtual session per connection over the shared one |
| `src/browser.ts` | `ZenBrowser`: tab targeting, keyboard and pointer input, dialogs, waits, screenshots |
| `src/locator.ts` | CSS, role, and accessible-name locators; each must match exactly one element |
| `src/launch.ts` | Starts a browser foxpaw can drive, in its own profile or yours; installs the `--dynamic` AutoConfig |
| `src/broker-client.ts` | Finds or starts the broker (`ensureBroker`) and talks to it |
| `src/cli.ts` | The `foxpaw` command: setup and one-off page commands |
| `src/index.ts` | The library entry point (`import … from 'foxpaw'`) |
| `autoconfig/` | The AutoConfig that starts remote control without the webdriver flag |
| `flake.nix`, `nix/` | Nix package, Home Manager module, and browser helpers |

## What the agent gets back

| Question | Answer in the response |
| --- | --- |
| Did the input reach the page? | `actionPerformed`. If the target moved or re-rendered before the input went out, nothing is sent and it's `false`. |
| Does the field hold what I asked for? | `verified`. When the input went through but the field reads back differently, the response says `actionPerformed: true, verified: false` so the agent knows not to type it again. |
| Did the result show up? | `waitFor` goes on the action and starts listening before the click. If it times out, the response includes what the page shows instead. |
| Did a dialog open? | `openPrompt: { type, message }`. Other actions on that tab are refused until the agent answers with `dialog`. |
| Did the form submit? | Constraint validation runs first. An invalid form comes back as `submitted: false` with the fields that failed. |
| Is this the right tab? | Anything that can change a page needs a `tabId`. Leaving it out is an error, so the agent can't act on whatever tab you happen to be looking at. |

With `waitFor`, the agent doesn't need to `sleep` after a click. Clicking a Register button looks like this:

```json
{ "action": "click", "tabId": "tab_2", "handle": "el_41",
  "waitFor": { "anyOf": [{ "text": "Registration Results" }, { "text": "Error" }] } }
```

It returns as soon as either text appears, including inside same-origin iframes. If a spinner is the only signal, `"state": "hidden"` waits for it to go away.

## Results

Here is the tool run against a fixture page in an isolated container in Zen, making the same calls an agent would:

| Call | Response |
| --- | --- |
| `click` with no `tabId` | Refused; page-changing actions need a tab |
| Click a button that calls `confirm("Drop this section?")` | `actionPerformed: true`, `openPrompt: { type: "confirm", message: "Drop this section?" }` |
| `inspect` while that dialog is open | Refused, with the open dialog repeated |
| `dialog` accept | Handled; the page's `confirm()` returned `true` |
| `check` the box named "Section 002", where two boxes share the same CSS and id | Only that one ticked (`[false, true]`), `verified: true` |
| `select` "Spring" in a list with a disabled placeholder | `selectedIndex: 2`, one `change` event, `verified: true` |
| `select` the disabled option | Refused, nothing changed |
| `submit_form` with a required field empty | `submitted: false`, `invalidFields: [{ name: "email", validationMessage: "Please fill out this field." }]` |
| `click` + `waitFor` on text that appears 600 ms later | `waitCompleted: true` |
| `click` + `waitFor` on text that never appears | `actionPerformed: true`, `waitCompleted: false`, the error, and a page summary |

That's one fixture page, so treat it as a smoke test. Waits can't see into cross-origin iframes. The unit tests use fakes, and only the opt-in integration tests drive Firefox.

## Security

Firefox's Remote Agent has no authentication and no encryption. While it's running, any process on your machine that can reach the port can read and control every tab in that profile, including the ones you're signed in to. foxpaw can't fix that. Here's what it does to keep from making it worse.

Both clients refuse endpoints that aren't loopback, and the broker only binds to `127.0.0.1`.

Firefox's default for an automation session is to close `alert`, `confirm`, `prompt`, and "Leave site?" dialogs on its own, in every tab, including yours. foxpaw's session turns that off.

Checking which browser features exist only reads state. Disposable test containers from `open({ isolation: "test" })` are deleted when their last tab closes or the omp session ends.

Failure reports and event buffers drop cookie values, auth headers, token, password, and secret query parameters, request and response bodies, typed text, prompt text, and file paths.

Don't add `--remote-allow-hosts`, `--remote-allow-origins`, or `--remote-allow-system-access`. Mozilla's [Security aspects of the Remote Agent](https://firefox-source-docs.mozilla.org/remote/Security.html) has the details.

The AutoConfig behind `--dynamic` turns off the browser's "allow this connection?" prompt, so it opens the port only in a browser started with `FOXPAW_REMOTE_CONTROL=1`, which `foxpaw launch --dynamic` sets. Starting the same browser any other way leaves remote control off.

## Install

Pick one. Each gives you the `foxpaw` command; the oh-my-pi routes also install the `zen_browser` tool.

```sh
omp plugin install github:nunera/foxpaw         # oh-my-pi: the zen_browser tool (omp ships its own Bun)
bun install -g github:nunera/foxpaw             # the foxpaw command, with Bun 1.1+
nix run github:nunera/foxpaw -- launch          # Nix, without installing; see "Nix" below to install
```

omp loads tools when a session starts, so open a new one after installing. From a checkout, `omp plugin link .` installs your working copy instead. `bun run build` makes `dist/foxpaw`, one file with Bun inside, for machines without Bun.

## Start a browser

Remote control can only be switched on when a browser starts. Starting your everyday profile again while it's open doesn't help: the running browser takes the command, opens a window, and ignores the flag. So foxpaw starts a browser of its own next to yours:

```sh
foxpaw launch
```

That opens Zen or Firefox (whichever it finds first; `--browser` or `FIREFOX_BIDI_BROWSER` picks one) as a separate process with foxpaw's own profile, in `~/.local/share/foxpaw/profile`. Sign in to the sites the agent should use there once; the logins stay. Your everyday browser keeps running. If something already listens on the port, `launch` does nothing, so it's safe to call every time.

From an agent, the same thing is `zen_browser` with `action: "launch"`. When no browser is running, every other action fails with a message saying so. Set `FIREFOX_BIDI_AUTO_LAUNCH=1` and the broker launches one by itself the first time anything needs it.

To use your everyday profile instead, quit the browser, then:

```sh
foxpaw launch --profile "$HOME/.zen/<profile>"     # the path is in about:profiles
```

`launch` refuses a profile that's still open and names the process holding it. foxpaw never edits a profile you bring.

### Without the webdriver flag

A browser started with `--remote-debugging-port` tells every page `navigator.webdriver = true`, and bot checks such as Cloudflare Turnstile read it. `foxpaw launch --dynamic` instead starts remote control from inside the browser, the way Firefox's own assistant tooling does, and pages see `false`. It needs foxpaw's AutoConfig in the browser's install directory:

```sh
foxpaw autoconfig install            # finds the browser; pass its install directory (the one with omni.ja) otherwise
foxpaw launch --dynamic
```

Installs managed by a package manager (Nix, Flatpak, distro packages) are read-only or get replaced on update; build the AutoConfig into the package instead (Nix: below). Dynamic mode always listens on port 9222.

## Use it from your own programs

Any language with a WebDriver BiDi client, or just a WebSocket, can share the browser with agents and other programs:

```sh
foxpaw ensure --launch     # starts the browser and the broker if needed, prints ws://127.0.0.1:9223/session
```

Connect to the printed URL and send `session.new` as usual. The broker exits a minute after `ensure` if nothing connects, and otherwise once its last client leaves, so connect right away. From Python:

```python
url = subprocess.run(["foxpaw", "ensure", "--launch"], check=True, capture_output=True, text=True).stdout.strip()
```

In Bun, import it instead:

```ts
import { BrokerBidiClient, launchBrowser, ZenBrowser } from 'foxpaw';

await launchBrowser();
const browser = new ZenBrowser(new BrokerBidiClient());   // starts the broker when needed
console.log(await browser.contexts());
```

## Nix

The flake has the package (`packages.<system>.default`, also as `overlays.default`), a Home Manager module, and two ways to build the `--dynamic` AutoConfig into a browser. Nothing rebuilds a browser from source.

```nix
# flake.nix inputs
foxpaw.url = "github:nunera/foxpaw";

# Home Manager
imports = [ inputs.foxpaw.homeModules.default ];
programs.foxpaw = {
  enable = true;
  browser = pkgs.firefox;     # or a path; unset, the first Zen or Firefox on PATH
  dynamic = true;             # launch without the webdriver flag (needs the AutoConfig below)
  autoLaunch = true;          # the broker starts the browser when an agent needs it
  omp.enable = true;          # zen_browser tool for oh-my-pi
};
```

The AutoConfig for `dynamic`:

```nix
# Firefox and other browsers built with nixpkgs' wrapFirefox
pkgs.firefox.override inputs.foxpaw.lib.wrapFirefoxArgs

# Prebuilt browsers whose wrapper doesn't read wrapFirefox's mozilla.cfg, such as the Zen flake
# (github:0xc000022070/zen-browser-flake)
(import "${inputs.zen-browser}/wrap-zen.nix" pkgs.wrapFirefox)
  (inputs.zen-browser.packages.${system}.twilight-unwrapped.overrideAttrs inputs.foxpaw.lib.withRemoteControl) { }
```

`wrapFirefoxArgs` sets `extraPrefs` and `extraAutoConfig`; if you set those already, join yours with them. `homeModules.default` sets the `FIREFOX_BIDI_*` variables below through `home.sessionVariables`.

## CLI

Page commands go through the broker, so they work while agents use the browser. You pick a tab with a piece of its URL or title, and it has to match exactly one tab.

```sh
foxpaw status                  # browser, profile, and whether remote control and the broker are up
foxpaw open https://example.com
foxpaw fill duckduckgo.com 'input[name=q]' 'webdriver bidi'
foxpaw press duckduckgo.com Enter 'input[name=q]'
foxpaw wait-url duckduckgo.com '?q='
foxpaw screenshot duckduckgo.com ./results.png
```

Run `foxpaw help` to list every command. Selectors are CSS, and `>>>` crosses into open shadow roots (`yt-searchbox >>> textarea`). From a checkout without installing, `bun run start -- <command>` is the same.

## Reference

Every action and parameter is documented in [docs/zen-browser-tool.md](docs/zen-browser-tool.md).

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIREFOX_BIDI_URL` | `ws://127.0.0.1:9222/session` | Remote Agent endpoint the broker connects to; its port is the one `launch` opens |
| `FIREFOX_BIDI_BROKER_URL` | `ws://127.0.0.1:9223` | Broker endpoint clients connect to and start |
| `FIREFOX_BIDI_BROKER_PORT` | port of the broker URL | Listen port of `foxpaw broker` |
| `FIREFOX_BIDI_BROWSER` | first Zen or Firefox found | Browser executable `launch` starts |
| `FIREFOX_BIDI_PROFILE` | `~/.local/share/foxpaw/profile` | Profile `launch` uses |
| `FIREFOX_BIDI_LAUNCH` | unset | `dynamic`: launch without the webdriver flag |
| `FIREFOX_BIDI_AUTO_LAUNCH` | unset | `1`: the broker launches the browser when none is listening |

`ZEN_BIDI_URL` and `ZEN_BIDI_BROKER_URL` also work. If both are set, the `FIREFOX_*` one wins. foxpaw's profile, `browser.log`, and `broker.log` live in `$XDG_DATA_HOME/foxpaw` (macOS: `~/Library/Application Support/foxpaw`).

### Development

```sh
bun run check   # tsc --noEmit over src/, extension/, test/
bun test        # unit tests; integration tests skip unless you opt in
nix flake check # builds the package and loads the extension from the Nix store

# These drive a real browser and open and close their own tabs.
FIREFOX_BIDI_INTEGRATION=1 bun test test/zen.integration.test.ts     # direct session; stop the broker first
FIREFOX_BIDI_INTEGRATION=1 bun test test/query.integration.test.ts   # through the broker; needs user contexts
```

`ZEN_BROWSER_EXTENSION` points the extension tests at a different copy of the extension.

### Further reading

- W3C, [WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/)
- Mozilla, [Remote Protocols](https://firefox-source-docs.mozilla.org/remote/index.html)

## License

[MIT](LICENSE)
