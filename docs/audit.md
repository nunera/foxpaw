# Audit log, record & replay

foxpaw writes one line for every `zen_browser` call: what ran, on which tab and element, what happened, and what refused it. You can read it with `foxpaw log`, and turn a session into a script that `foxpaw replay` runs again.

## Where it goes

`$XDG_STATE_HOME/foxpaw/audit/YYYY-MM-DD.jsonl` (default `~/.local/state/foxpaw/audit/`; `~/Library/Application Support/foxpaw/state/audit/` on macOS, `%LOCALAPPDATA%\foxpaw\state\audit\` on Windows), one file per local day. The directory is `0700` and the files are `0600`. Screenshots go in a folder per day next to the logs.

Each tool instance (one oh-my-pi session, one MCP server, one `foxpaw replay`) gets a random session id. A line:

```json
{
  "time": "2026-11-26T07:27:36.912Z",
  "session": "104b3975f4d9",
  "host": "omp",
  "seq": 7,
  "action": "click",
  "tabId": "tab_3",
  "urlBefore": "http://127.0.0.1:40671/",
  "urlAfter": "http://127.0.0.1:40671/done?count=1&gift=true",
  "documentChanged": true,
  "target": { "selector": "html > body > main > button:nth-of-type(2)", "tag": "button", "role": "button", "name": "Checkout", "text": "Checkout" },
  "params": { "action": "click", "tabId": "tab_3", "handle": "el_3", "waitFor": { "urlChanged": true } },
  "outcome": "ok",
  "result": { "actionPerformed": true, "waitCompleted": true, "navigation": true },
  "screenshots": { "before": ".../audit/2026-11-26/104b3975f4d9-7-before.png", "after": ".../audit/2026-11-26/104b3975f4d9-7-after.png" },
  "durationMs": 41
}
```

- `host` is `omp`, `mcp`, or `cli` (replay), `unknown` for other programs.
- `seq` counts the session's calls from 1.
- `outcome` is `ok`, `failed` (the call ran and failed), or `refused` (a feature such as policy stopped it before it reached the page; `result.policy` has the decision and reason).
- `result` keeps `actionPerformed`, `verified`, `waitCompleted`, `navigation`, `failedStepIndex` (batch), `openedTabId` (open), `openPrompt` (dialog type), and `error`.
- `target` describes the element an element action acted on. Never its contents: there is no `text` for inputs, text areas, selects, or text boxes.

What you typed is never logged. The values of `fill`, `type`, and `select` (also inside `fill_many`, `select_many`, and `batch` steps), `promptText`, and `expression` become `{"$redacted": <length>}`, and error messages that echo one of them are scrubbed. `fill_secret` logs only the secret's name.

## Configuration

The `audit` key in foxpaw's config file (`~/.config/foxpaw/config.json`; `FOXPAW_CONFIG` overrides):

```json
{ "audit": { "enabled": true, "screenshots": "writes", "retainDays": 30 } }
```

- `enabled` (default `true`).
- `screenshots`: `none`, `writes` (default: a screenshot before and after every action that can change a page: navigate, reload, history, clicks, drag, pointer, fill, type, press, select, check, their `_many` forms, batch, submit_form, upload, dialog, close, fill_secret), or `all` (every action on a tab).
- `retainDays` (default `30`): day files and screenshot folders older than this are deleted when a tool instance starts.

A screenshot is skipped, with the reason in `screenshots.beforeSkipped`/`afterSkipped`, when a page dialog is open, when your [policy](policy.md) doesn't allow reads on the page outright (`ask` or `deny`; the audit never asks you for a screenshot), when the tab is gone, or around `fill_secret` (the secret could be visible).

## foxpaw log

```sh
foxpaw log                                  # today, as a table
foxpaw log --since 2h                       # also 30m, 7d, 2026-11-26, or an ISO time
foxpaw log --session 104b39 --action click  # a session id prefix is enough
foxpaw log --tab tab_3 --json               # raw JSON lines
foxpaw log --follow                         # keep printing new lines (Ctrl-C to stop)
```

```
TIME      SESSION   SEQ  ACTION  TAB    TARGET                OUTCOME
01:27:36  104b3975  5    click   tab_3  button "Add item"     ok
01:27:36  104b3975  6    check   tab_3  checkbox "Gift wrap"  ok
01:27:36  104b3975  7    click   tab_3  button "Checkout"     ok, → http://127.0.0.1:40671/done?count=1&gift=true
```

## Record and replay

```sh
foxpaw record --session 104b3975 [--from 5] [--to 7] -o checkout.json
foxpaw replay checkout.json --dry-run
foxpaw replay checkout.json [--tab-url shop.example] [--var v1=SAVE10]
```

`record` keeps the session's successful calls that change a page or tab (between `seq` `--from` and `--to`, inclusive) and drops reads, waits, and `evaluate`. Failed or partly failed calls are left out and listed on stderr. The script names elements by role and accessible name when the element had both, by its CSS selector otherwise, never by `el_*` handles; elements inside an iframe also keep the frame's URL. When a step changed the page's URL, it gets a `waitFor: {url}` (or a following `wait_url` step for actions without `waitFor`), so replay doesn't run ahead of the page.

`replay` runs the script through a full `zen_browser` tool, so policy, secrets, and the audit log apply as they do for an agent. It opens a fresh tab at the script's start URL, or uses the one tab whose URL contains `--tab-url`. It stops at the first step that fails, isn't verified, doesn't produce the recorded page change, or opens a dialog the script doesn't handle, prints which step and why, and exits 1. `--dry-run` prints the steps and touches no browser.

Typed values aren't in the log, so they aren't in the script either: each is a `{"$var": "v1"}` placeholder listed in `vars`, and replay refuses to start until every one is given with `--var`. `fill_secret` steps need nothing; the secret is resolved again at replay.

### Script format (version 1)

```json
{
  "version": 1,
  "startUrl": "http://127.0.0.1:40671/",
  "recorded": { "session": "104b3975f4d9", "host": "omp", "at": "2026-11-26T07:27:41.689Z" },
  "vars": { "v1": { "length": 6, "step": 1, "field": "value", "target": "textbox \"Coupon\"" } },
  "steps": [
    { "action": "fill", "tab": "t1", "params": { "value": { "$var": "v1" } }, "target": { "locator": { "role": "textbox", "name": "Coupon" } } },
    { "action": "click", "tab": "t1", "params": { "waitFor": { "url": "http://127.0.0.1:40671/done" } }, "target": { "locator": { "css": "#checkout" } } },
    { "action": "open", "tab": "t1", "params": { "url": "https://help.example/" }, "opens": "t2" },
    { "action": "wait_url", "tab": "t2", "params": { "url": "https://help.example/start" } }
  ]
}
```

- `tab`: `t1` is the tab replay starts in; an `open` step's `opens` names the tab it creates.
- `params`: `zen_browser` parameters without `tabId`, `target`, or element fields.
- `target.locator`: `{role, name}` (exact name) or `{css}`; `target.frameUrl` for an element in an iframe. Batch steps carry their own `target`.
- `vars`: each placeholder's length, step index (from 0), field, and element, so you know what to pass.
- `source` (optional): the session and `seq` a step came from.

Scripts are plain JSON; edit them freely. Replay rejects any other `version`.
