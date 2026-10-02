# zen-bidi-relay

Control the Zen or Firefox browser you already use, with your real profile, over WebDriver BiDi.

Playwright and Selenium normally launch a clean, throwaway profile. That's right for testing and wrong when an agent has to work inside sites you're already signed in to. This project connects to the Remote Agent of a browser you started yourself, so your cookies, logins, extensions, and open tabs are all available.

| Path | What it is |
| --- | --- |
| `src/` | A small WebDriver BiDi client and a `ZenBrowser` class: tab targeting, CSS and role locators, native keyboard and pointer input, waits, screenshots. |
| `src/broker.ts` | A loopback WebSocket broker. Firefox allows one BiDi session at a time, so the broker owns it and lets several clients share it. |
| `extension/zen-browser.ts` | A `zen_browser` tool for the [oh-my-pi](https://github.com/can1357/oh-my-pi) coding agent. |
| `src/cli.ts` | A CLI for one-off commands and debugging. |

## Security

Firefox's Remote Agent has no authentication and no encryption. While it's on, any process on your machine that can reach the port can read and control every tab in that profile, including signed-in sessions.

What this project does about it:

- The direct client and the broker client both refuse non-loopback endpoints, and the broker binds only to `127.0.0.1`.
- Diagnostics, traces, and event buffers drop cookie values, auth headers, token/password/secret query parameters, request and response bodies, typed text, prompt text, and file paths.
- Operations that change browser state (cookie import/export, emulation, permissions, request routing) only run in isolated test tabs, never against your normal profile.

It can't stop other local software from connecting to port 9222. Don't add `--remote-allow-hosts`, `--remote-allow-origins`, or `--remote-allow-system-access`, and restart the browser normally when you're done. Mozilla covers the details in [Security aspects of the Remote Agent](https://firefox-source-docs.mozilla.org/remote/Security.html).

## Requirements

- [Bun](https://bun.sh) 1.x
- Zen or Firefox with WebDriver BiDi support. I develop against Zen Twilight.
- oh-my-pi, if you want the agent tool

## Getting started

Quit the browser first; the flag only takes effect at startup. Your profile path is listed in `about:profiles`. The binary name depends on how you installed Zen (`zen`, `zen-twilight`, a Flatpak, and so on).

```sh
# Zen Twilight
zen-twilight --remote-debugging-port=9222 --profile "$HOME/.zen/<profile>"

# Firefox
firefox --remote-debugging-port=9222 --profile "$HOME/.mozilla/firefox/<profile>"
```

Then:

```sh
git clone https://github.com/nunera/zen-bidi-relay.git
cd zen-bidi-relay
bun install
bun run start -- tabs
```

If `tabs` prints your open tabs as JSON, it's working.

## CLI

Each command opens a BiDi session, does one thing, and ends the session. You pick a tab with a substring of its URL or title, and it has to match exactly one tab. Raw context IDs aren't accepted because they only exist for the session that created them.

```sh
bun run start -- open https://example.com
bun run start -- navigate example.com https://duckduckgo.com
bun run start -- fill duckduckgo.com 'input[name=q]' 'webdriver bidi'
bun run start -- press duckduckgo.com Enter 'input[name=q]'
bun run start -- wait-url duckduckgo.com 'q='
bun run start -- screenshot duckduckgo.com ./results.png
bun run start -- evaluate duckduckgo.com 'document.title'
```

Run `bun run start` with no arguments to see every command, including `click`, `type`, `select`, `check`, `upload`, `scroll`, `wait-for`, `activate`, and `close`.

Selectors are CSS. Use `>>>` to cross into open shadow roots, as in `yt-searchbox >>> textarea`. `fill` replaces a field's contents and `type` appends to them; both send real key events.

The CLI connects to Firefox directly, so it fails while the broker holds the session. Close your omp sessions first, or stop the broker.

## oh-my-pi tool

```sh
bun run install-extension
```

This symlinks `extension/zen-browser.ts` into `~/.omp/agent/extensions/`. omp loads extensions when a session starts, so open a new session after installing or editing it.

The first tool call starts the broker on `ws://127.0.0.1:9223` in the background. It owns the BiDi session, runs requests one at a time, and forwards events to every connected omp session. When the last one disconnects, the broker ends the session and exits.

The tool is meant to be used in this order:

1. `tabs` lists tabs with a `tabId`. A `tabId` stays valid across navigation for the life of the omp session.
2. `inspect` returns element handles (`el_*`). A handle belongs to one document. After a navigation or re-render it fails with `stale element handle` rather than acting on whatever replaced it, so call `inspect` again.
3. Act on an element by handle, CSS `selector`, or `role` plus `name`.

Pointer actions resolve their target again right before sending input and confirm it's the same element. If the page swapped it in between, you get `actionPerformed: false` and no pointer events are sent.

`open({ isolation: "test" })` puts the tab in a throwaway Firefox user context. Anything that changes browser state requires one of these tabs. If your browser build is missing an optional BiDi module, the tool returns `Feature unavailable in this Zen/Firefox build: <feature>` and doesn't fall back to page scripts.

Every action is documented in [docs/zen-browser-tool.md](docs/zen-browser-tool.md).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIREFOX_BIDI_URL` | `ws://127.0.0.1:9222/session` | Remote Agent endpoint used by the CLI and the broker |
| `FIREFOX_BIDI_BROKER_URL` | `ws://127.0.0.1:9223` | Broker endpoint the extension connects to |
| `FIREFOX_BIDI_BROKER_PORT` | `9223` | Listen port when you run `bun run broker` yourself |

`ZEN_BIDI_URL` and `ZEN_BIDI_BROKER_URL` work as fallbacks. If both are set, the `FIREFOX_*` value wins.

## Development

```sh
bun run check   # tsc --noEmit
bun test        # unit tests; integration tests skip by default
```

The integration tests drive a real browser and only run when you opt in. Each one opens and closes its own tabs.

```sh
# Direct BiDi session. Stop the broker first.
FIREFOX_BIDI_INTEGRATION=1 bun test test/zen.integration.test.ts

# Goes through the broker, so it can run alongside omp. Needs user-context support.
FIREFOX_BIDI_INTEGRATION=1 bun test test/query.integration.test.ts
```

Set `ZEN_BROWSER_EXTENSION` to run the extension tests against a different copy of the extension.

## References

- W3C, [WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/)
- Mozilla, [Remote Protocols](https://firefox-source-docs.mozilla.org/remote/index.html)

## License

[MIT](LICENSE)
