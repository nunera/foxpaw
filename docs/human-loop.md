# Human loop: pause, tab leases, agent spaces

Several agents (and you) can share one browser through the broker. foxpaw keeps them from acting on each other's tabs, lets you stop every agent at once and take over, and shows which tabs an agent controls.

## Pause and take over

```sh
foxpaw pause      # hold every agent's input, navigation, and script commands
foxpaw resume
foxpaw status     # "humanLoop": {"paused": true, "since": …, "by": …, "leasedTabs": 1}
```

Or press **Ctrl+Alt+P** in a tab an agent controls; press it again to resume.

While paused, the broker does not send input, navigation, tab creation or closing, dialog handling, or script evaluation from any client, foxpaw's tool or a plain BiDi program. Each held command goes out once you resume, or is refused when its timeout runs out first (10 seconds for the tool's commands; plain BiDi clients wait up to 10 minutes). Reads that cannot change a page (the tab tree, screenshots) still pass.

The agent is told: an action that starts while paused waits up to its `timeoutMs` (at most 30 s) for you to resume, then fails with `paused: true` and a note to wait or ask you instead of retrying. An action the pause caught halfway reports the same, and says part of it may have run.

The pause belongs to the running broker. It ends with it, which happens when the last agent disconnects. `foxpaw pause` never starts a broker: with no agent connected there is nothing to pause.

The hotkey only counts real key presses (`isTrusted`), so a page cannot pause or resume the agent by faking one. It is installed with the overlay below, so it works in agent-controlled tabs only.

## Tab leases

A client that acts on a tab (navigates, clicks, types, closes it, answers its dialog, … in the tab or a frame in it) holds that tab until it releases it, disconnects, or the tab closes. A tab a client opens is its own from the start. Other clients' commands on it are refused with an error naming the holder:

```json
{"tabId": "tab_3", "action": "click", "actionPerformed": false, "error": "This tab is in use by \"omp 3f2a\"; nothing was sent.", "leasedBy": "omp 3f2a", "note": "…"}
```

- `tabs` marks tabs other agents hold with `leasedBy: "other"` and `leaseOwner`.
- `waitForTabMs` on an action waits that long for the holder to release the tab instead of failing at once.
- `release` {tabId} hands a tab back; leases also end when the agent's session ends.
- Script evaluation in a held tab is refused too, since it can change the page, but it does not take a lease by itself (listing tabs evaluates every tab's title).
- Reading actions in the tool (`inspect`, `query`, `screenshot`, waits, …) never take a lease. `screenshot` and the tab tree work on any tab; reads that evaluate page script are refused on another agent's tab.
- Commands that target a script realm instead of a browsing context are not tied to a tab and are not checked.

```sh
foxpaw leases     # which agent holds which tab, with URLs
```

Each agent is named after its host and a short random id (`omp 3f2a`, `mcp 91c0`); plain BiDi connections are `BiDi client N`.

### Broker protocol

Plain BiDi clients on `/session` get the same leases and pause automatically. Clients of foxpaw's envelope protocol on `/` have these extra request kinds (`{id, kind, …}`, answered with `{id, result}` or `{id, error}`):

| kind | fields | result |
| --- | --- | --- |
| `identify` | `owner`, `color` (`#rrggbb`), both optional | `{owner, color}` |
| `lease` | `context`, `owner?`, `waitMs?` | `{context, owner}` (the tab) or error `tab leased` |
| `release` | `context?` (all of this client's tabs when omitted) | `{released: [contexts]}` |
| `leases` | | `{leases: [{context, owner, color, since, mine}], pause}` |
| `pause` | `owner?` (shown as who paused) | `{paused, since, by}` |
| `resume` | | `{paused: false}` |
| `pauseState` | `waitMs?` (wait up to 60 s for a resume) | `{paused, since?, by?}` |

Refused commands fail with error `tab leased` (`data.leasedBy`, `data.context`) or `paused` (`data.paused: true`).

## Overlay

Every tab an agent holds shows a small label in the bottom-right corner with the agent's name and color ("agent active · Ctrl+Alt+P pauses"), turning amber with a border while paused. During clicks, hovers, and drags an arrow cursor in the agent's color moves to where the pointer goes.

The overlay and the hotkey run in an isolated script realm the page cannot reach; the overlay sits in a closed shadow root, ignores the pointer (`pointer-events: none`), and cannot change what the agent's clicks hit. It is added once the page has loaded and removed when the agent releases the tab.

## Agent spaces

With spaces enabled, `open` puts an agent's tabs in a container (Firefox user context) of their own, so their cookies and logins stay apart from yours. `tabs` shows them with `isolation: "space"`.

- `perSession: true` (default): a fresh container per agent session, removed together with its tabs when the session ends.
- `perSession: false`: one shared agent container, kept across sessions, so you sign agents in once.

`open` with `isolation: "test"` still uses a disposable container of its own.

## Configuration

In foxpaw's config file (`foxpaw policy show` prints its path):

```json
{
  "humanLoop": { "hotkey": "Ctrl+Alt+P", "overlay": true },
  "spaces": { "enabled": false, "perSession": true }
}
```

- `humanLoop.hotkey`: modifiers (`Ctrl`, `Alt`, `Shift`, `Meta`) plus a letter, digit, or F1–F12; at least one of Ctrl, Alt, or Meta. Matched by physical key, so it works with any keyboard layout. The broker reads it when it starts; an invalid value is logged to `broker.log` and the default used.
- `humanLoop.overlay: false` hides the label and cursor; the hotkey still works.
- `spaces` is read on every `open`.
