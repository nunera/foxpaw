# Policy

foxpaw sorts every `zen_browser` call into one of three classes and decides per site whether it runs, needs your approval, or is refused. The decision happens before anything reaches the page.

| class | actions |
|---|---|
| read | `tabs`, `inspect`, `query`, `table`, `form_schema`, `field_state`, `screenshot`, `events`, waits, `assert`, `hover`, `scroll`, `activate` |
| write | `navigate`, `open`, `reload`, `history`, `close`, `fill`, `type`, `select`, `check`, `upload`, `drag`, `fill_secret`, clicks on ordinary elements, and actions added by other features |
| irreversible | `submit_form`, `evaluate` (page script can do anything), batch `commit` steps, and `click`, `double_click`, `pointer` up, or `press` Enter (also `type` text with a newline) on a submit control, on an element whose accessible name or text contains one of the words pay, purchase, buy, order, checkout, delete, remove, send, submit, confirm, transfer, publish, post, sign, unsubscribe (whole words, any case), or on any element inside a `<form method="post">`. Accepting a dialog whose message contains one of those words is irreversible too. |

`press` Enter with no target goes to whatever has focus, so it counts as irreversible. A `batch` takes the class of its most severe step.

With no configuration, reads and writes are allowed and irreversible actions ask.

## Configuration

The `policy` key in foxpaw's config file (`~/.config/foxpaw/config.json`; `FOXPAW_CONFIG` overrides):

```json
{
  "policy": {
    "default": { "read": "allow", "write": "allow", "irreversible": "ask" },
    "sites": [
      { "match": "*.bank.example", "write": "ask", "irreversible": "deny" },
      { "match": "https://pay.bank.example", "irreversible": "ask" },
      { "match": "news.example", "write": "deny" }
    ],
    "approval": { "method": "auto", "timeoutMs": 120000 }
  }
}
```

Each of `read`, `write`, `irreversible` is `allow`, `ask`, or `deny`.

`match` is one of:

- `https://pay.bank.example`: exactly that origin (scheme, host, port).
- `bank.example`: that host, any scheme or port.
- `*.bank.example`: any subdomain of `bank.example` (not `bank.example` itself).

For each class, the most specific site that sets it wins (origin, then exact host, then the longest wildcard); a site that leaves a class out falls through to the next match and finally to `default`. In the example, `pay.bank.example` asks for irreversible actions and still asks for writes (from `*.bank.example`).

The decision uses the URL of the tab the call acts on. When the target element lives in an iframe, the iframe's URL counts too and the stricter decision wins: a `deny` for `*.evil.example` holds for an evil.example iframe on your bank's page, even if the bank itself is allowed. The prompt then names the iframe. `open` uses the URL being opened; `navigate` uses the stricter of the current page and the destination.

The file is read on every call, so edits apply at once. If it can't be read or `policy` is invalid, every action is refused, and the refusal names the file, the setting, and what's wrong.

Check a decision without a browser:

```sh
foxpaw policy check https://pay.bank.example/send click
foxpaw policy show
```

## Approval

`ask` blocks the call until you answer. A timeout (`approval.timeoutMs`, default 120 s), a closed prompt, or no available approver means deny.

`approval.method` is one method or a list, tried in order; the first one available asks.

- `auto` (default): `approval.command` if set, then the desktop prompt for your system.
- `notify-send`: a Linux notification with Approve and Deny buttons. Needs libnotify 0.7.9 or newer and a notification server that supports actions (GNOME, KDE, mako, dunst, swaync).
- `osascript`: a macOS dialog.
- `powershell`: a Windows message box.
- `command`: runs `approval.command` (a program path, or `[program, ...args]`; no shell). It gets the request as one line of JSON on stdin and approves only by exiting 0. Use it for a phone push, a password prompt, or scripted tests.
- `browser`: an overlay in the tab itself. It lives in a closed shadow root in a sandbox page scripts can't reach, stays on top, ignores synthetic clicks, and ignores clicks in its first 600 ms. The page still owns everything around it and can hide it or trick you into clicking, so it is weaker than a desktop prompt. Use it only where there is no desktop.

The request every approver sees:

```json
{
  "version": 1,
  "site": "https://shop.example",
  "url": "https://shop.example/cart",
  "tabId": "tab_2",
  "action": "click",
  "class": "irreversible",
  "reason": "submit control; default says ask",
  "target": { "tag": "button", "role": "button", "name": "Pay", "text": "Pay", "selector": "#pay" },
  "form": { "action": "https://shop.example/pay", "method": "post" },
  "timeoutMs": 120000
}
```

Some hosts stop waiting for a tool before you answer (Codex: 60 s by default); raise the host's tool timeout or lower `approval.timeoutMs`.

## What the agent sees

A refused call fails with `actionPerformed: false` and the decision:

```json
{
  "tabId": "tab_2",
  "action": "click",
  "actionPerformed": false,
  "error": "foxpaw policy refused this action: the user did not approve: denied via notify-send",
  "policy": { "decision": "ask", "reason": "the user did not approve: denied via notify-send", "class": "irreversible", "site": "https://shop.example", "rule": "default" },
  "note": "Nothing reached the page. Do not retry or work around this; tell the user what you wanted to do and why."
}
```

`decision` is `deny` for a deny rule or an invalid config, and `ask` when you didn't approve.

## Limits

Classification looks at the element and form at the moment of the call. A page can still do anything on an ordinary click (a `<div>` that sends a payment from a script), so words and forms are a net, not a guarantee; `deny` writes on sites where any click matters.
