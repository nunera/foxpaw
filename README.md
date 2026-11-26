<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" width="64%" alt="foxpaw: an orange mouse pointer with four toe beans above its tip, next to the wordmark fox in ink and paw in orange">
  </picture>
</p>

<p align="center">
  Let an AI agent, or any program, use a Zen or Firefox that's signed in to your accounts.<br>
  An <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a> tool and a small CLI, over WebDriver BiDi.
</p>

<p align="center">
  <img alt="Zen and Firefox" src="https://img.shields.io/badge/Zen%20%C2%B7%20Firefox-real%20profile-ff7139?style=flat-square&labelColor=141414&logo=firefoxbrowser&logoColor=ff7139">
  <img alt="WebDriver BiDi" src="https://img.shields.io/badge/WebDriver-BiDi-f3f4f0?style=flat-square&labelColor=141414">
  <img alt="Loopback only" src="https://img.shields.io/badge/network-loopback%20only-ff7139?style=flat-square&labelColor=141414">
  <img alt="Bun" src="https://img.shields.io/badge/Bun-1.x-f3f4f0?style=flat-square&labelColor=141414&logo=bun&logoColor=f3f4f0">
  <img alt="Nix flake" src="https://img.shields.io/badge/Nix-flake-f3f4f0?style=flat-square&labelColor=141414&logo=nixos&logoColor=7ebae4">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-f3f4f0?style=flat-square&labelColor=141414&logo=typescript&logoColor=f3f4f0">
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#what-the-agent-gets-back">Responses</a> ·
  <a href="#use-it-from-your-own-programs">Programs</a> ·
  <a href="#nix">Nix</a> ·
  <a href="#security">Security</a> ·
  <a href="#reference">Reference</a>
</p>

<br>

## Why

Playwright and Selenium start their own clean browser. That's what you want for tests. It's useless when the page the agent needs is behind your login, and getting there again means SSO plus a two-factor prompt on your phone.

foxpaw gives the agent a browser that already has your logins. Usually that's one foxpaw starts next to your everyday browser, in a profile of its own that you sign in to once. It can also be your everyday profile. Either way the agent works in real tabs, and you can watch it click.

Working in a signed-in browser changes what a mistake costs. If the agent misreads a page in a test browser, you rerun the test. Here it might submit a form twice. Most of the code exists so the agent can tell what a click actually did before it decides what to do next.

## Get started

Install it whichever way you already install things:

| You use | Run | You get |
| --- | --- | --- |
| oh-my-pi | `omp plugin install github:nunera/foxpaw` | the `zen_browser` tool (omp brings its own Bun) |
| Bun 1.1+ | `bun add -g --trust github:nunera/foxpaw` | the `foxpaw` command |
| Nix | `nix run github:nunera/foxpaw -- launch` | a one-off run; [install it properly](#nix) |
| none of these | a binary from [Releases](https://github.com/nunera/foxpaw/releases) | one file with its runtime inside |

Then start a browser for it:

```sh
foxpaw launch
```

A new Zen or Firefox window opens. It's a separate process with its own profile, so your everyday browser keeps running. Sign in to the sites the agent should use; the logins stay for next time.

In oh-my-pi, open a new session (tools load at startup) and ask for something in the browser. The agent calls `tabs`, then `inspect` for element handles, then acts on them. If it finds no browser running, it can call `launch` itself.

## Start a browser

Firefox only turns on remote control when it starts, and it can't be switched on later. The obvious workaround, starting your everyday profile again with `--remote-debugging-port`, does nothing while that browser is open: the running browser takes the command, opens a window, and ignores the flag. That's why foxpaw starts its own browser rather than asking you to restart yours.

`foxpaw launch` picks the first Zen or Firefox it finds (`--browser` or `FIREFOX_BIDI_BROWSER` picks one) and keeps the profile in `~/.local/share/foxpaw/profile`. If something already listens on the port, it does nothing, so scripts can call it every time. With `FIREFOX_BIDI_AUTO_LAUNCH=1`, the broker launches the browser itself the first time anything needs one.

You can still use your everyday profile. Quit the browser first, then:

```sh
foxpaw launch --profile "$HOME/.zen/<profile>"     # the path is in about:profiles
```

`launch` refuses a profile that's still open and tells you which process holds it. It never edits a profile you bring.

### Without the webdriver flag

A browser started with `--remote-debugging-port` tells every page `navigator.webdriver = true`, and bot checks such as Cloudflare Turnstile look for it. `foxpaw launch --dynamic` starts remote control from inside the browser instead, the same way Firefox's own assistant tooling does, and pages see `false`.

It needs a small AutoConfig file in the browser's install directory:

```sh
# Finds the browser; otherwise pass its install directory (the one with omni.ja)
foxpaw autoconfig install
foxpaw launch --dynamic
```

If a package manager owns the browser (Nix, Flatpak, a distro package), that directory is read-only or gets replaced on update. Build the AutoConfig into the package instead; [Nix](#nix) shows how. Dynamic mode always listens on port 9222.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-it-works-dark.svg">
  <img src="docs/assets/how-it-works-light.svg" width="100%" alt="Three agent sessions connect to the foxpaw broker on 127.0.0.1:9223. The broker holds the one WebDriver BiDi session to your signed-in Zen or Firefox on port 9222, where the agent's pointer clicks Register on a registration page.">
</picture>

Firefox allows one WebDriver BiDi session at a time, so a small broker holds it and everyone else talks to the broker. Requests run concurrently, and each response goes back to whoever sent it. You never start the broker by hand: the tool, the CLI, and `foxpaw ensure` start it when it isn't running, and it exits when its last client leaves. While it's shutting down it turns new clients away, and they start a fresh one.

Programs that speak plain WebDriver BiDi connect to `ws://127.0.0.1:9223/session` instead of Firefox's port, and each connection gets a session of its own. The broker answers `session.new`, `session.end`, and `session.status` itself. Everything else runs on the shared session, with three rules so clients can't step on each other:

- A client only receives events it subscribed to, and only for the tabs it named. Events from an iframe count as its tab's.
- A request held by a network intercept goes only to the client that added the intercept. Otherwise a submit guard, which fails every held request it doesn't recognize, would fail everyone else's too.
- When a client leaves, the broker fails the requests it was still holding, then removes its intercepts, preload scripts, and subscriptions. A held request is never let through on behalf of a client that's gone.

## What the agent gets back

| Question | Answer in the response |
| --- | --- |
| Did the input reach the page? | `actionPerformed`. If the target moved or re-rendered before the input went out, nothing is sent and it's `false`. |
| Does the field hold what I asked for? | `verified`. When the input went through but the field reads back differently, the response says `actionPerformed: true, verified: false`, so the agent knows not to type it again. |
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

### Results

I ran the tool against a fixture page in an isolated container in Zen, making the same calls an agent would:

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

That's one fixture page, so treat it as a smoke test. Waits can't see into cross-origin iframes. The unit tests use fakes; only the opt-in integration tests drive a real browser.

## Use it from your own programs

Anything with a WebDriver BiDi client, or just a WebSocket, can share the browser with agents and other programs. One command gets you a URL:

```sh
foxpaw ensure --launch     # starts the browser and the broker if needed
# ws://127.0.0.1:9223/session
```

Connect to it and send `session.new` as usual. Connect soon, though. The broker exits a minute after `ensure` if nobody shows up, and otherwise once its last client leaves.

From Python:

```python
url = subprocess.run(
    ["foxpaw", "ensure", "--launch"], check=True, capture_output=True, text=True,
).stdout.strip()
```

From Bun, import it:

```ts
import { BrokerBidiClient, launchBrowser, ZenBrowser } from 'foxpaw';

await launchBrowser();
const browser = new ZenBrowser(new BrokerBidiClient());   // starts the broker when needed
console.log(await browser.contexts());
```

## Nix

The flake has the package (also as `overlays.default`), a Home Manager module, and helpers that build the AutoConfig for dynamic mode into a browser. None of them rebuild a browser from source.

```nix
# flake.nix
inputs.foxpaw.url = "github:nunera/foxpaw";

# Home Manager
imports = [ inputs.foxpaw.homeModules.default ];

programs.foxpaw = {
  enable = true;
  browser = pkgs.firefox;   # a package or a path; unset, the first Zen or Firefox on PATH
  dynamic = true;           # launch without the webdriver flag (needs the AutoConfig below)
  autoLaunch = true;        # the broker starts the browser when something needs it
  omp.enable = true;        # the zen_browser tool for oh-my-pi
};
```

For `dynamic`, the browser needs the AutoConfig. Pick the line that matches how you get your browser:

```nix
# Firefox, and anything else built with nixpkgs' wrapFirefox
pkgs.firefox.override inputs.foxpaw.lib.wrapFirefoxArgs

# Prebuilt browsers whose wrapper skips mozilla.cfg, such as the Zen flake
# (github:0xc000022070/zen-browser-flake)
let zen = inputs.zen-browser.packages.${system}.twilight-unwrapped; in
(import "${inputs.zen-browser}/wrap-zen.nix" pkgs.wrapFirefox)
  (zen.overrideAttrs inputs.foxpaw.lib.withRemoteControl) { }
```

`wrapFirefoxArgs` sets `extraPrefs` and `extraAutoConfig`. If you already set those, join yours with foxpaw's. The Home Manager module sets the `FIREFOX_BIDI_*` [variables](#reference) through `home.sessionVariables`.

## CLI

Page commands go through the broker, so they work while agents are using the browser. You pick a tab with a piece of its URL or title, and it has to match exactly one tab.

```sh
foxpaw status                  # browser, profile, and whether remote control and the broker are up
foxpaw open https://example.com
foxpaw fill duckduckgo.com 'input[name=q]' 'webdriver bidi'
foxpaw press duckduckgo.com Enter 'input[name=q]'
foxpaw wait-url duckduckgo.com '?q='
foxpaw screenshot duckduckgo.com ./results.png
```

`foxpaw help` lists every command. Selectors are CSS, and `>>>` crosses into open shadow roots (`yt-searchbox >>> textarea`). In a checkout, `bun run start -- <command>` runs the same thing without installing.

## Security

Firefox's Remote Agent has no authentication and no encryption. While it runs, any process on your machine that can reach the port can read and control every tab in that profile, signed-in ones included. foxpaw can't fix that, but it tries not to make it worse:

- Both clients refuse endpoints that aren't loopback, and the broker only binds to `127.0.0.1`.
- By default, Firefox closes `alert`, `confirm`, `prompt`, and "Leave site?" dialogs on its own during automation, in every tab, yours included. foxpaw's session turns that off.
- Checking which browser features exist only reads state. Disposable test containers from `open({ isolation: "test" })` are deleted when their last tab closes or the omp session ends.
- Failure reports and event buffers drop cookie values, auth headers, token, password, and secret query parameters, request and response bodies, typed text, prompt text, and file paths.
- The `--dynamic` AutoConfig turns off the browser's "allow this connection?" prompt. To make up for that, it only opens the port in a browser started with `FOXPAW_REMOTE_CONTROL=1`, which `foxpaw launch --dynamic` sets. Start the same browser any other way and remote control stays off.

Don't add `--remote-allow-hosts`, `--remote-allow-origins`, or `--remote-allow-system-access`. Mozilla's [Security aspects of the Remote Agent](https://firefox-source-docs.mozilla.org/remote/Security.html) has the details.

## Reference

Every `zen_browser` action and parameter is documented in [docs/zen-browser-tool.md](docs/zen-browser-tool.md).

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIREFOX_BIDI_URL` | `ws://127.0.0.1:9222/session` | Remote Agent endpoint the broker connects to; `launch` opens this port |
| `FIREFOX_BIDI_BROKER_URL` | `ws://127.0.0.1:9223` | Where clients find (and start) the broker |
| `FIREFOX_BIDI_BROKER_PORT` | the broker URL's port | Listen port of `foxpaw broker` |
| `FIREFOX_BIDI_BROWSER` | first Zen or Firefox found | Browser `launch` starts |
| `FIREFOX_BIDI_PROFILE` | `~/.local/share/foxpaw/profile` | Profile `launch` uses |
| `FIREFOX_BIDI_LAUNCH` | unset | `dynamic`: launch without the webdriver flag |
| `FIREFOX_BIDI_AUTO_LAUNCH` | unset | `1`: the broker launches a browser when none is listening |

`ZEN_BIDI_URL` and `ZEN_BIDI_BROKER_URL` also work; if both are set, the `FIREFOX_*` one wins. foxpaw keeps its profile, `browser.log`, and `broker.log` in `$XDG_DATA_HOME/foxpaw` (`~/Library/Application Support/foxpaw` on macOS).

### Development

```sh
bun run check     # tsc --noEmit over src/, extension/, test/
bun test          # unit tests; integration tests skip unless you opt in
nix flake check   # builds the package and loads the extension from the Nix store
omp plugin link . # use this checkout as your zen_browser tool

# These drive a real browser and open and close their own tabs.
# The first uses a direct session (stop the broker first); the second goes
# through the broker and needs user contexts.
FIREFOX_BIDI_INTEGRATION=1 bun test test/zen.integration.test.ts
FIREFOX_BIDI_INTEGRATION=1 bun test test/query.integration.test.ts
```

`ZEN_BROWSER_EXTENSION` points the extension tests at a different copy of the extension.

| Path | What it is |
| --- | --- |
| `extension/zen-browser.ts` | The `zen_browser` tool for oh-my-pi |
| `src/cli.ts` | The `foxpaw` command |
| `src/launch.ts` | Starts a browser foxpaw can drive; installs the AutoConfig |
| `src/broker.ts` | The loopback broker that shares the BiDi session |
| `src/broker-client.ts` | Finds or starts the broker, and talks to it |
| `src/mux.ts` | Plain WebDriver BiDi on `/session`: one virtual session per connection |
| `src/browser.ts` | `ZenBrowser`: tab targeting, keyboard and pointer input, dialogs, waits, screenshots |
| `src/locator.ts` | CSS, role, and accessible-name locators; each must match exactly one element |
| `src/index.ts` | The library entry point |
| `autoconfig/` | The AutoConfig behind `--dynamic` |
| `flake.nix`, `nix/` | Nix package, Home Manager module, and browser helpers |

### Further reading

- W3C, [WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/)
- Mozilla, [Remote Protocols](https://firefox-source-docs.mozilla.org/remote/index.html)

## License

[MIT](LICENSE)
