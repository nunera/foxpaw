# `zen_browser` tool reference

The oh-my-pi tool in `extension/zen-browser.ts` takes one `action` per call. This page covers what each action does and the behavior that isn't obvious from the parameter schema.

## Targeting

Call `tabs` first and pass its `tabId` on every call. `target`, a URL or title substring that matches exactly one tab, works too. On Zen, `tabs` hides the per-window `about:blank` placeholder Zen marks as `zen-empty-tab`.

Actions that can change a page require `tabId` or `target` and never fall back to the focused tab, which is usually the one the user is working in. Only reading and waiting actions (`inspect`, `form_schema`, `field_state`, `query`, `table`, `events`, `wait_event`, `wait_for`, `wait_for_change`, `wait_url`, `assert`, `assert_many`, `screenshot`) and `open` (which only uses the tab to place the new one) fall back to the single focused tab when neither is given.

Element actions take one of:

- `handle`: an `el_*` handle from `inspect` (preferred)
- `selector`: CSS, with `>>>` to cross open shadow roots
- `role` and optional exact `name`: implicit roles include button, link, textbox, spinbutton, checkbox, radio, and combobox
- `locator`: the structured form (`css`, `role`, `name`, `exact`, `checked`, `disabled`, `within`, `frame`)

`selector`, `role`, `name`, and the `locator` fields are merged into one locator, and all of them must match the same single element; a field that conflicts with the same `locator` field is an error. `name` alone doesn't identify an element. A `handle` can't be combined with the others.

A handle stores its frame, document ID, and identity (tag, role, accessible name, node ID). If any of those no longer match, or a locator matches more than one element, the action fails instead of guessing.

Handles are scoped to one document. `tabId`s survive navigation but not a new omp session; in a new session, call `tabs` and `inspect` again.

## Page dialogs

The relay's BiDi session asks Firefox to leave `alert`, `confirm`, `prompt`, and `beforeunload` dialogs open (`unhandledPromptBehavior: ignore`), so they behave normally in the user's own tabs.

When an action opens a dialog, or one is open when it finishes, the response contains `openPrompt: { type, message, defaultValue? }` and the action counts as performed (`actionPerformed: true`); any `waitFor` is abandoned because the page is blocked. `tabs` shows `openPrompt` on the affected tab. Every other action on that tab is refused with `actionPerformed: false` until `dialog` accepts or dismisses it. `tabs`, `dialog`, `close`, `activate`, and `open` still work.

Dialogs are tracked from the first tool call of the session; one that was already open before then isn't reported, but `dialog` can still handle it.

## Actions

### Reading the page

| Action | Notes |
| --- | --- |
| `tabs` | Lists tabs (with `openPrompt` where a dialog is open) and whether this build supports user contexts (`capabilities`). |
| `inspect` | Returns handles. `mode` is `interactive` (default), `content`, or `semantic`. `root` limits the scope and is included if it matches. `maxElements` defaults to 100 (max 500). The response gives the `frame` once, then `elements`, `count`, and `truncated: true` when more elements matched than were returned. `semantic` is a DOM-derived snapshot with landmark paths, not the browser's accessibility tree. |
| `query` | Requires `selector`. Returns matches in the top-level document in document order, hidden elements included, up to 200, with `total` and `truncated`. `fields` maps output names to `tag`, `role`, `name`, `text`, or an HTML attribute name; missing attributes come back as `null`. Doesn't search iframes or shadow roots. |
| `table` | Extracts headers and cell text from `<table>` elements under `selector` or `root`. Each table returns at most 200 rows, with `rowCount` and `truncated`. |
| `form_schema` | Lists the visible fields in the page (or under `root`) with label, kind, value, required/disabled, select options, and the submit control. Hidden inputs, passwords, and token/session/auth-looking fields are left out. |
| `field_state` | Current state of one field, including whether something is covering it. |
| `evaluate` | Runs `expression` in the page. A single expression is wrapped in an `async` arrow so non-native promises (Zone.js on Angular, for example) are awaited; statement sequences run as written. `timeoutMs` can go up to one hour. If the expression opens a dialog, the response reports `openPrompt` instead of a value. |
| `screenshot` | Returns the PNG inline. `format: "path"` (default) also writes it to `output` or `/tmp/zen-bidi-<timestamp>.png`; `format: "base64"` skips the file. `fullPage: true` captures the whole document. With an element target, it crops to that element in document coordinates, so it works inside frames and shadow roots without scrolling. |

### Navigation and tabs

| Action | Notes |
| --- | --- |
| `open` | Requires `url`. The new tab opens in the foreground next to the reference tab (`tabId` or `target`), in the same window. With no visible tab, omit the reference. `isolation: "test"` opens it in a new disposable user context (container) with its own cookies. |
| `navigate`, `reload` | `reload` reloads the current document, including URLs with a `#fragment`. |
| `history` | `dx` is the traversal delta, e.g. `-1` for back. |
| `activate`, `close` | Closing the last tab of a test context also removes the context. Test contexts still open when the omp session ends are removed then. |
| `dialog` | `dialogAction` is `accept` or `dismiss`; `promptText` fills a prompt. Returns the handled `prompt`. It doesn't wait for anything the dialog triggers; follow with a wait action. |

### Input

| Action | Notes |
| --- | --- |
| `click`, `double_click`, `right_click`, `hover` | Native pointer input. Responses include `target: { tag, role, name }`. |
| `drag` | Drags to `destination`. |
| `pointer` | Single `down`, `move`, or `up` with optional `dx`/`dy`. |
| `fill` | Selects the field's contents and types `value` with native key events, then reads the field back. |
| `type` | Appends `text`. Without an element target it types into whatever has focus (no read-back). |
| `press` | Keys and chords such as `Enter` or `Control+Shift+R`, optionally on an element. |
| `scroll` | `dx` and/or `dy` scroll the window; the missing axis defaults to 0. With an element target and no offsets, scrolls it to the center of the viewport. |
| `select` | `value` is an option value or its visible text. Sets the option directly and fires one bubbling `input` and `change`, as a single user choice would; selecting the already-selected option fires nothing (`changed: false`). Disabled options, options in a disabled `optgroup`, and disabled selects are refused before anything changes. |
| `check` | `checked` is the desired state. Clicks the control natively (or its label when the input is hidden or covered), then reads it back for up to one second. |
| `upload` | `files` are absolute paths. |

Pointer actions resolve their target again immediately before sending input. Every selector segment has to match exactly one element, and that element has to be the one originally resolved. Otherwise the response is `actionPerformed: false` and no input is sent.

`fill`, `type` (with a target), `select`, and `check` verify the result. `verified: true` means the control reads back as requested. `verified: false` with `verifyError` means the input **was** sent (`actionPerformed: true`) but the control reads differently, for example a field that reformats its value or a checkbox the page reverted. Don't resend it; look at the field with `field_state` first.

### Forms

| Action | Notes |
| --- | --- |
| `fill_many`, `select_many`, `check_many` | `fields` maps selector to value (`"true"`/`"1"` for `check_many`). Runs in order and stops at the first failure, reporting `failedStepIndex`. A step whose input was sent but didn't verify, or that opened a dialog, stops the run with `actionPerformed: true`. |
| `batch` | Ordered steps: `fill`, `clear`, `select`, `check`, `press`, `scroll`, `assert`, `click`, and `commit`. `commit` is a click you've marked as irreversible, and the response sets `committed: true` when one ran. A step that performed its input but then failed its wait (`waitFailed`), its read-back (`unverified`), or opened a dialog (`promptOpened`) stops the batch at that step with `actionPerformed: true`. Steps already completed are not rolled back on failure. |
| `assert`, `assert_many` | Compares an element `property` against `equals`. |
| `submit_form` | Submits the form of the given control (with that control as the submitter when it is a submit button) and optionally waits on `waitFor` or `waitUrl`. Constraint validation runs first; if the form is invalid nothing is submitted and the call fails with `submitted: false` and `invalidFields: [{ name, validationMessage }]`. Forms with `novalidate` (or a `formnovalidate` submitter) skip the check. |

### Waiting

| Action | Notes |
| --- | --- |
| `wait_for` | A plain `selector` waits for an element that may not exist yet; a plain `text` waits for that case-sensitive substring of the visible page text. `waitFor` accepts `selector`, `text`, `state` (`"visible"` default, or `"hidden"` to wait for the selector/text to disappear), `url`, `urlChanged`, `documentChanged`, and `pageIdleMs`, or `{ "anyOf": [...] }` of those. Every key in one predicate must hold. |
| `wait_url` | Waits until a document whose URL contains `url` has loaded (`domContentLoaded`, or already past the `loading` state). The query string is ignored unless `url` contains `?`, so an SSO page carrying `?service=https://portal.example.edu` doesn't match `portal.example.edu`. The fragment counts. A navigation that has only started doesn't count. The `url` and `urlChanged` predicates of `waitFor` follow the same rule. |
| `wait_for_change` | Waits for a navigation or a substantial content change: at least 24 characters of visible text or three elements in the main content. With `selector`, watches only that element and any change counts, including the element appearing. Returns the change and `summary: { heading, text }` (first `h1`, first 300 characters of main content). |
| `wait_event` | Waits for one of `eventTypes` on this tab (matching the event's `context` or `source.context`) and returns it. |

Other actions (`click`, `navigate`, `press`, `select`, `submit_form`, `batch` steps, …) also accept `waitFor` (or `waitUrl`); prefer that over a separate wait call. The wait is armed before input, so a fast navigation isn't missed. `timeoutMs` defaults to 10 seconds and caps at one hour, and also applies to `batch` step waits. The tool runs one call at a time per omp session, so a long wait blocks later calls.

Wait for the final content, not a loading placeholder: `{ "anyOf": [{ "text": "Registration Results" }, { "text": "Error" }] }` rather than waiting for "Processing…" to show up.

If the input went through but the wait failed, the response has `actionPerformed: true`, `waitCompleted: false`, `waitError`, and `summary: { heading, text }` of the page as it is now. Don't retry blindly in that case; the click already happened. Failure responses carry a `diagnostic` with the last 20 navigation, network, and console entries seen during the action (`networkCount` gives the full network count).

Selector and text waits search the top document and same-origin iframes. Content inside cross-origin iframes is not visible to them.

### Events

| Action | Notes |
| --- | --- |
| `events` | Subscribes the tab to `eventTypes` (for example `browsingContext.load`, `network.responseCompleted`, `log.entryAdded`, `browsingContext.downloadWillBegin`, `browsingContext.downloadEnd`) and returns the buffered events that belong to this tab or its frames. `eventLimit` caps the shared buffer, up to 500. |

Event buffers are redacted (see the README) and live only in memory.

If the browser lacks user-context support, `open` with `isolation: "test"` fails with `Feature unavailable in this Zen/Firefox build: browserUserContexts`.
