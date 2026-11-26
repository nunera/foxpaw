<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" width="64%" alt="foxpaw: an orange mouse pointer with four toe beans above its tip, next to the wordmark fox in ink and paw in orange">
  </picture>
</p>

<p align="center">
  Let an AI agent use a Zen or Firefox that's signed in to your accounts, without handing it the keys.<br>
  Works in Claude Code, Codex, Cursor, and any MCP host, and natively in <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a>.
</p>

<p align="center">
  <img alt="Zen and Firefox" src="https://img.shields.io/badge/Zen%20%C2%B7%20Firefox-real%20profile-ff7139?style=flat-square&labelColor=141414&logo=firefoxbrowser&logoColor=ff7139">
  <img alt="WebDriver BiDi" src="https://img.shields.io/badge/WebDriver-BiDi-f3f4f0?style=flat-square&labelColor=141414">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-stdio%20%C2%B7%20HTTP-f3f4f0?style=flat-square&labelColor=141414">
  <img alt="Loopback only" src="https://img.shields.io/badge/network-loopback%20%2B%20token-ff7139?style=flat-square&labelColor=141414">
  <img alt="Node and Bun" src="https://img.shields.io/badge/Node%2022%20%C2%B7%20Bun-f3f4f0?style=flat-square&labelColor=141414&logo=nodedotjs&logoColor=f3f4f0">
  <img alt="Nix flake" src="https://img.shields.io/badge/Nix-flake-f3f4f0?style=flat-square&labelColor=141414&logo=nixos&logoColor=7ebae4">
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#safety">Safety</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#what-the-agent-gets-back">Responses</a> ·
  <a href="#benchmarks">Benchmarks</a> ·
  <a href="#nix">Nix</a> ·
  <a href="#reference">Reference</a>
</p>

<br>

## Why

Playwright and Selenium start their own clean browser. That's what you want for tests. It's useless when the page the agent needs is behind your login, and getting there again means SSO plus a two-factor prompt on your phone.

foxpaw gives the agent a browser that already has your logins. Usually that's one foxpaw starts next to your everyday browser, in a profile of its own that you sign in to once. It can also be your everyday profile. Either way the agent works in real tabs, and you can watch it click.

Working in a signed-in browser changes what a mistake costs. If the agent misreads a page in a test browser, you rerun the test. Here it might pay twice, or delete the wrong thing. So foxpaw is built around not letting that happen: you decide per site what the agent may do, it asks before anything irreversible, it never sees your passwords, every action is logged, and you can freeze it with a key press.

## Get started

Install the `foxpaw` command whichever way you already install things ([all routes](docs/install.md)):

| You use | Run |
| --- | --- |
| Node 22+ | `npm install -g @nunera/foxpaw` |
| Bun 1.1+ | `bun add -g @nunera/foxpaw` |
| Nix | `nix profile install github:nunera/foxpaw`, or [the flake](#nix) |
| neither | a binary from [Releases](https://github.com/nunera/foxpaw/releases), with its runtime inside |

The npm package is `@nunera/foxpaw`. The unscoped name `foxpaw` there belongs to an unrelated package, so don't install that.

Then give your agent the `zen_browser` tool:

| Agent | Run |
| --- | --- |
| Claude Code | `claude mcp add foxpaw -- foxpaw mcp` |
| Codex, Cursor, any MCP host | command `foxpaw`, args `["mcp"]` ([snippets](docs/mcp.md)) |
| oh-my-pi | `omp plugin install github:nunera/foxpaw` (no separate install needed; omp brings its own Bun) |

Start a browser for it:

```sh
foxpaw launch
```

A new Zen or Firefox window opens. It's a separate process with its own profile, so your everyday browser keeps running. Sign in to the sites the agent should use; the logins stay for next time.

Ask your agent for something in the browser. It calls `tabs`, then `snapshot` or `inspect` for element handles, then acts on them. If no browser is running, it can call `launch` itself.

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

## Safety

Everything here is on by default except where it says otherwise, and it applies the same way in every host, because it lives in the tool rather than in a host's settings. One JSON file, `~/.config/foxpaw/config.json`, configures all of it.

**Per-site policy.** Every call is a read, a write, or irreversible: submitting a form, paying, deleting, sending, `evaluate`, or clicking a button whose label says so. Signing in is a write, so logins don't ask every time. Each site gets `allow`, `ask`, or `deny` per class. With no config, irreversible actions ask. Asking means a desktop prompt with Approve and Deny (a notification on Linux, a dialog on macOS and Windows); no answer within two minutes is a no.

```json
{
  "policy": {
    "default": { "read": "allow", "write": "allow", "irreversible": "ask" },
    "sites": [{ "match": "*.bank.example", "write": "ask", "irreversible": "deny" }]
  }
}
```

Targets inside an iframe are judged by the iframe's site too, and the stricter rule wins. [policy.md](docs/policy.md) has the full rules and the other ways to approve.

**Secrets the model never sees.** `fill_secret` types a password from `pass`, Bitwarden, 1Password, the system keyring, or an environment variable. The agent only names it (`"secret": "bank"`), and foxpaw fills it only on the origins you list for it, so a prompt-injected page on another site can't ask for it. Afterwards the value is scrubbed from every result and error, and `evaluate` is refused on that page. [secrets.md](docs/secrets.md)

**An audit log.** Every action, including refused ones, goes to a daily log under `~/.local/state/foxpaw/audit/`, with before and after screenshots for writes. Typed values aren't logged, only their length. `foxpaw log` browses it, and `foxpaw record` turns a session into a script that `foxpaw replay` runs again without a model. [audit.md](docs/audit.md)

**You can take over.** Press Ctrl+Alt+P in a tab the agent is using (or run `foxpaw pause`) and every agent stops before its next input; press it again to hand control back. Tabs an agent holds show a small label and its cursor. Two agents can't act on the same tab: the first one to touch it holds it until it lets go. Set `"spaces": { "enabled": true }` and each agent session gets its own container, with its own cookies. [human-loop.md](docs/human-loop.md)

**The connection.** Firefox's remote control has no authentication, so foxpaw keeps it to this machine and adds what it can on top. The broker and the MCP HTTP server bind to 127.0.0.1 only, refuse any request a web page could send (anything with an `Origin` header, or a `Host` that isn't loopback, which is what DNS rebinding uses), and require a token that's new each time they start and readable only by you (`$XDG_RUNTIME_DIR/foxpaw/`). Page dialogs stay open instead of being dismissed for you, and event buffers drop cookies, auth headers, bodies, and typed text.

Don't add `--remote-allow-hosts`, `--remote-allow-origins`, or `--remote-allow-system-access`. Mozilla's [Security aspects of the Remote Agent](https://firefox-source-docs.mozilla.org/remote/Security.html) has the details.

**Where the line is.** Policy, secrets, and the audit log live in the `zen_browser` tool. They stop a model that misreads a page or follows an injected instruction while all it has is the browser. They don't stop an agent that can also run shell commands as you, and most coding agents can: it can read the token and talk to the broker directly, or edit the config to allow everything. Programs that use the broker's plain BiDi endpoint are trusted the same way. For tasks you don't trust, give the agent the browser tool and nothing else: [lockdown.md](docs/lockdown.md) has the exact flags for Claude Code, Codex, and oh-my-pi.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-it-works-dark.svg">
  <img src="docs/assets/how-it-works-light.svg" width="100%" alt="Three agent sessions connect to the foxpaw broker on 127.0.0.1:9223. The broker holds the one WebDriver BiDi session to your signed-in Zen or Firefox on port 9222, where the agent's pointer clicks Register on a registration page.">
</picture>

Firefox allows one WebDriver BiDi session at a time, so a small broker holds it and everyone else talks to the broker: oh-my-pi sessions, MCP servers, the CLI, and your own programs. Requests run concurrently, and each response goes back to whoever sent it. You never start the broker by hand. Anything that needs it starts it, and it exits when its last client leaves. While it's shutting down it turns new clients away, and they start a fresh one.

Programs that speak plain WebDriver BiDi connect to `/session` on the broker, and each connection gets a session of its own. The broker answers `session.new`, `session.end`, and `session.status` itself. Everything else runs on the shared session, with rules so clients can't step on each other:

- A client only receives events it subscribed to, and only for the tabs it named. Events from an iframe count as its tab's.
- A request held by a network intercept goes only to the client that added the intercept.
- A tab one client is acting on is refused to the others until it's released (read-only calls such as screenshots still work).
- When a client leaves, the broker fails the requests it was still holding, then removes its intercepts, preload scripts, subscriptions, and tab holds.

## What the agent gets back

| Question | Answer in the response |
| --- | --- |
| Did the input reach the page? | `actionPerformed`. If the target moved or re-rendered before the input went out, nothing is sent and it's `false`. |
| Does the field hold what I asked for? | `verified`. When the input went through but the field reads back differently, the response says `actionPerformed: true, verified: false`, so the agent knows not to type it again. |
| Did the result show up? | `waitFor` goes on the action and starts listening before the click. If it times out, the response includes what the page shows instead. |
| Did a dialog open? | `openPrompt: { type, message }`. Other actions on that tab are refused until the agent answers with `dialog`. |
| Did the form submit? | Constraint validation runs first. An invalid form comes back as `submitted: false` with the fields that failed. |
| Was it allowed? | A refusal says `actionPerformed: false` with `policy: { decision, reason }`, before anything touched the page. |
| Is this the right tab? | Anything that can change a page needs a `tabId`. Leaving it out is an error, so the agent can't act on whatever tab you happen to be looking at. |

With `waitFor`, the agent doesn't need to `sleep` after a click. Clicking a Register button looks like this:

```json
{ "action": "click", "tabId": "tab_2", "handle": "el_41",
  "waitFor": { "anyOf": [{ "text": "Registration Results" }, { "text": "Error" }] } }
```

It returns as soon as either text appears, in any frame of the tab. If a spinner is the only signal, `"state": "hidden"` waits for it to go away.

Pages are cheap to read. `snapshot` returns a compact text tree with element handles, and the next call on the same page returns only what changed: on the benchmark's list page, 543 characters the first time and 20 after one item was added. For vision models, `screenshot` with `marks: true` numbers the clickable elements on the image, keyed to the same handles. Both see into cross-origin iframes, and `downloads` and `wait_download` pick up the files a click produced. [agent-ux.md](docs/agent-ux.md)

## Benchmarks

`bun bench/run.ts` runs twelve scripted tasks against local fixture sites in a real headless browser, through the same tool an agent uses, and counts every state-changing request the sites receive. Anything a task didn't ask for is an unintended side effect. The tasks cover logins, a checkout that ends in Pay, a delete behind a confirm dialog, a re-rendering list, shadow DOM, a cross-origin iframe form, uploads, downloads, slow results, a page with a prompt injection next to a "Close account" button, and a lookalike login page on another origin.

| Run | Tasks passed | Unintended side effects | Approvals asked | Tool calls |
| --- | --- | --- | --- | --- |
| Zen 1.25t (Twilight), headless, Linux | 12/12 | 0 | 6 | 69 |
| Firefox 160 in the NixOS VM test (`nix flake check`) | 12/12 | 0 | 6 | 69 |

These are scripted tasks, so they measure the tool, not a model. `bun bench/agent.ts` runs the same tasks with a model driving foxpaw, Playwright MCP, or chrome-devtools-mcp and reports success, tokens, and side effects, through the Anthropic API or through Claude Code on a Claude subscription. Those numbers will go here once they've been run. [benchmarks.md](docs/benchmarks.md)

## Use it from your own programs

Anything with a WebDriver BiDi client, or just a WebSocket, can share the browser with agents and other programs. One command gets you a URL with the broker's token in it:

```sh
foxpaw ensure --launch     # starts the browser and the broker if needed
# ws://127.0.0.1:9223/session?token=…
```

Connect to it and send `session.new` as usual. Connect soon, though. The broker exits a minute after `ensure` if nobody shows up, and otherwise once its last client leaves.

A token in a URL tends to end up in logs and process lists. If your client can set headers, run `foxpaw ensure --json` instead: it prints the URL and the token separately, and you send the token as `Authorization: Bearer <token>`.

From Python:

```python
url = subprocess.run(
    ["foxpaw", "ensure", "--launch"], check=True, capture_output=True, text=True,
).stdout.strip()
```

From Node or Bun, add it as a dependency (`bun add github:nunera/foxpaw`) and import it:

```ts
import { BrokerBidiClient, launchBrowser, ZenBrowser } from '@nunera/foxpaw';

await launchBrowser();
const browser = new ZenBrowser(new BrokerBidiClient());   // starts the broker when needed
console.log(await browser.contexts());
```

## Nix

The flake has the package (also as `overlays.default`), a Home Manager module, a NixOS VM test, and helpers that build the AutoConfig for dynamic mode into a browser. None of them rebuild a browser from source.

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
foxpaw status                  # browser, profile, broker, pause state
foxpaw open https://example.com
foxpaw fill duckduckgo.com 'input[name=q]' 'webdriver bidi'
foxpaw press duckduckgo.com Enter 'input[name=q]'
foxpaw screenshot duckduckgo.com ./results.png
foxpaw log --since 2h          # what agents did
foxpaw pause                   # stop every agent; foxpaw resume hands back
```

`foxpaw help` lists every command, including `mcp`, `policy`, `secrets`, `record`, `replay`, and `leases`. Selectors are CSS, and `>>>` crosses into open shadow roots (`yt-searchbox >>> textarea`).

## Reference

Every `zen_browser` action and parameter is documented in [docs/zen-browser-tool.md](docs/zen-browser-tool.md).

| Variable | Default | Purpose |
| --- | --- | --- |
| `FOXPAW_CONFIG` | `~/.config/foxpaw/config.json` | The config file: `policy`, `secrets`, `audit`, `humanLoop`, `spaces`, `downloads` |
| `FIREFOX_BIDI_URL` | `ws://127.0.0.1:9222/session` | Remote Agent endpoint the broker connects to; `launch` opens this port |
| `FIREFOX_BIDI_BROKER_URL` | `ws://127.0.0.1:9223` | Where clients find (and start) the broker |
| `FIREFOX_BIDI_BROKER_PORT` | the broker URL's port | Listen port of `foxpaw broker` |
| `FIREFOX_BIDI_BROWSER` | first Zen or Firefox found | Browser `launch` starts |
| `FIREFOX_BIDI_PROFILE` | `~/.local/share/foxpaw/profile` | Profile `launch` uses |
| `FIREFOX_BIDI_LAUNCH` | unset | `dynamic`: launch without the webdriver flag |
| `FIREFOX_BIDI_AUTO_LAUNCH` | unset | `1`: the broker launches a browser when none is listening |

`ZEN_BIDI_URL` and `ZEN_BIDI_BROKER_URL` also work; if both are set, the `FIREFOX_*` one wins. foxpaw keeps its profile, downloads, and logs in `$XDG_DATA_HOME/foxpaw`, the audit log in `$XDG_STATE_HOME/foxpaw`, and tokens in `$XDG_RUNTIME_DIR/foxpaw` (macOS and Windows use their usual app folders).

### Development

```sh
bun run check       # tsc --noEmit over src/, extension/, test/
bun test            # unit tests; integration tests skip unless you opt in
bun bench/run.ts    # the scripted benchmark against a real headless browser
nix flake check     # package, extension from the Nix store, and the NixOS VM benchmark
bun run build:node  # dist/ for Node; build:bin for single-file binaries
omp plugin link .   # use this checkout as your zen_browser tool
```

`FIREFOX_BIDI_INTEGRATION=1 bun test test/zen.integration.test.ts` and `test/query.integration.test.ts` drive a real browser; the first talks to Firefox directly, so stop the broker first.

| Path | What it is |
| --- | --- |
| `src/tool/` | The `zen_browser` tool (`core.ts`) and its features: policy, secrets, audit, snapshots, marks, downloads, leases, pause, spaces |
| `extension/zen-browser.ts` | The oh-my-pi adapter |
| `src/mcp/` | The MCP server (stdio and Streamable HTTP) |
| `src/broker.ts`, `src/mux.ts`, `src/human/` | The broker, plain-BiDi sessions, tab holds and pause |
| `src/trust/`, `src/audit/` | Policy, approvals, secrets; audit log, record, and replay |
| `src/browser.ts`, `src/locator.ts` | `ZenBrowser`: BiDi helpers, frames, input, waits, locators |
| `src/launch.ts`, `src/cli.ts` | Starting browsers; the `foxpaw` command |
| `bench/`, `nix/` | Benchmarks and fixtures; Nix package, Home Manager module, VM test |

### Further reading

- W3C, [WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/)
- Mozilla, [Remote Protocols](https://firefox-source-docs.mozilla.org/remote/index.html)
- [Model Context Protocol](https://modelcontextprotocol.io)

## License

[MIT](LICENSE)
