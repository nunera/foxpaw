# `zen_browser` tool reference

The oh-my-pi tool in `extension/zen-browser.ts` takes one `action` per call. This page covers what each action does and the behavior that isn't obvious from the parameter schema.

## Targeting

Most actions need a tab. Pass `tabId` from `tabs`, or `target`, a URL or title substring that matches exactly one tab. On Zen, `tabs` hides the per-window `about:blank` placeholder Zen marks as `zen-empty-tab`.

Element actions take one of:

- `handle`: an `el_*` handle from `inspect`
- `selector`: CSS, with `>>>` to cross open shadow roots
- `role` and optional exact `name`: implicit roles include button, link, textbox, spinbutton, checkbox, radio, and combobox
- `locator`: the structured form (`css`, `role`, `name`, `exact`, `checked`, `disabled`, `within`, `frame`)

All four go through the same resolver. A handle stores its frame, document ID, and identity (tag, role, accessible name, node ID). If any of those no longer match, or a role/name lookup matches more than one element, the action fails instead of guessing.

Handles are scoped to one document. `tabId`s survive navigation but not a new omp session; in a new session, call `tabs` and `inspect` again.

## Actions

### Reading the page

| Action | Notes |
| --- | --- |
| `tabs` | Lists tabs and the BiDi capabilities this browser build supports. |
| `inspect`, `controls` | Returns handles. `mode` is `interactive` (default), `content`, or `semantic`. `root` limits the scope and is included if it matches. `maxElements` defaults to 100. `semantic` is a DOM-derived snapshot with landmark paths, not the browser's accessibility tree. |
| `query` | Requires `selector`. Returns every match in the top-level document in document order, hidden elements included. `fields` maps output names to `tag`, `role`, `name`, `text`, or an HTML attribute name; missing attributes come back as `null`. Doesn't search iframes or shadow roots. |
| `table` | Extracts headers and cell text from `<table>` elements under `selector` or `root`. |
| `form_schema`, `form_values` | Lists the visible fields in a form (or under `root`) with label, kind, value, required/disabled, select options, and the submit control. Hidden inputs, passwords, and token/session/auth-looking fields are left out. |
| `field_state` | Current state of one field, including whether something is covering it. |
| `evaluate` | Runs `expression` in the page. A single expression is wrapped in an `async` arrow so non-native promises (Zone.js on Angular, for example) are awaited; statement sequences run as written. `timeoutMs` can go up to one hour. |
| `screenshot` | Returns the PNG inline. `format: "path"` (default) also writes it to `output` or `/tmp/zen-bidi-<timestamp>.png`; `format: "base64"` skips the file. `fullPage: true` captures the whole document. With an element target, it crops to that element in document coordinates, so it works inside frames and shadow roots without scrolling. |

### Navigation and tabs

| Action | Notes |
| --- | --- |
| `open` | Requires `url`. The new tab opens in the foreground next to the reference tab (`tabId` or `target`), in the same window. With no visible tab, omit the reference. `isolation: "test"` opens it in a new disposable user context. |
| `navigate`, `reload` | |
| `history` | `dx` is the traversal delta, e.g. `-1` for back. |
| `activate`, `close` | Closing the last tab of a test context also removes its routes and the context. |
| `dialog` | `dialogAction` is `accept` or `dismiss`; `promptText` fills a prompt. |

### Input

| Action | Notes |
| --- | --- |
| `click`, `double_click`, `right_click`, `hover` | Native pointer input. Responses include `target: { tag, role, name }`. |
| `drag` | Drags to `destination`. |
| `pointer` | Single `down`, `move`, or `up` with optional `dx`/`dy`. |
| `fill` | Selects the field's contents and types `value` with native key events, then reports the resulting value. |
| `type` | Appends `text`. Without an element target it types into whatever has focus. |
| `press` | Keys and chords such as `Enter` or `Control+Shift+R`, optionally on an element. |
| `scroll` | `dx` and/or `dy`; the missing axis defaults to 0. With an element target and no offsets, scrolls it to the center of the viewport. |
| `select`, `check`, `upload` | `value`, `checked`, and `files` respectively. `check` clicks the control natively. |

Pointer actions resolve their target again immediately before sending input. Every selector segment has to match exactly one element, and that element has to be the one originally resolved. Otherwise the response is `actionPerformed: false` and no input is sent.

### Forms

| Action | Notes |
| --- | --- |
| `fill_many`, `clear_many`, `select_many`, `check_many` | `fields` maps selector to value (`"true"`/`"1"` for `check_many`). Runs in order and stops at the first failure, reporting `failedStepIndex`. |
| `batch` | Ordered steps: `fill`, `clear`, `select`, `check`, `press`, `scroll`, `assert`, `click`, and `commit`. `commit` is a click you've marked as irreversible, and the response sets `committed: true` when one ran. Steps already completed are not rolled back on failure. |
| `assert`, `assert_many` | Compares an element `property` against `equals`. |
| `submit_form` | Clicks the given submit control and optionally waits on `waitFor`. |

### Waiting

| Action | Notes |
| --- | --- |
| `wait_for` | A plain `selector` waits for an element that may not exist yet. `waitFor` accepts `selector`, `text`, `url`, `urlChanged`, `documentChanged`, and `pageIdleMs`, or `{ "anyOf": [...] }` of those. |
| `wait_url` | Waits until the URL contains `url`. |
| `wait_for_change` | Waits for a navigation or a substantial content change: at least 24 characters of visible text or three elements. Returns the change and `summary: { heading, text }` (first `h1`, first 300 characters of main content). |
| `wait_event` | Waits for one of `eventTypes`. |

Other actions also accept `waitFor` (or `waitUrl`). The wait is armed before input, so a fast navigation isn't missed. `timeoutMs` defaults to 10 seconds and caps at one hour. The tool runs one call at a time, so a long wait blocks later calls.

If the input went through but the wait failed, the response has `actionPerformed: true`, `waitCompleted: false`, and `waitError`. Don't retry blindly in that case; the click already happened.

### Events and diagnostics

| Action | Notes |
| --- | --- |
| `events` | Subscribes the tab to `eventTypes` (`browsingContext.*`, `network.*`, `log.entryAdded`, `browser.download*`) and returns the buffer. `eventLimit` caps it, up to 500. |
| `downloads` | The same buffer, filtered to download events. |
| `diagnostics` | Recent action diagnostics for the tab. |
| `report` | `kind: "accessibility"` (DOM-based findings, not a conformance audit), `"performance"` (navigation and resource timing), or `"failure"` (last failed action). |
| `trace_start`, `trace_stop`, `trace_export` | Records actions as JSONL. Nothing is written until you give an `output` path. |
| `trace_replay` | `replayMode` defaults to `dry_run`. `safe` replays only inspection, waits, hover, scroll, and screenshots. |

Event buffers, diagnostics, and traces are redacted (see the README) and live only in memory unless you export them.

### Test contexts

These require a tab opened with `isolation: "test"` and fail on normal tabs with `State operations require an isolated test tab.`

| Action | Notes |
| --- | --- |
| `state_export`, `state_import` | Cookies only, as a `zen-bidi-state-v1` JSON file at `output`. Doesn't cover Local Storage or IndexedDB. |
| `emulate` | Passes `emulation` to the browser's emulation module. |
| `permissions` | Sets `permission: { name, state }`. Reset when the tab closes. |
| `route_add`, `route_remove`, `route_list` | Intercepts requests matching `route.url`. `fulfill` routes need `status` and `body`. |

If the browser lacks the BiDi module an action needs, you get `Feature unavailable in this Zen/Firefox build: <feature>`.
