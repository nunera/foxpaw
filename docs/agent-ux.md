# Snapshots, marks, frames, and downloads

These parts of the `zen_browser` tool keep pages cheap to read and let an agent act inside iframes and on downloads. They run in every host (oh-my-pi, MCP) through `defaultFeatures()`.

## `snapshot`

`snapshot` `{ tabId, root?, maxNodes?, full? }` returns the page as indented text, one line per meaningful element:

```
main el_15
  heading "Checkout" [h1] el_16
  text "Review your order." el_17
  button "Add plums" el_20
  form el_22
    textbox "Email" [required] el_23
    combobox = "Standard" el_25
  iframe "Payment" el_26
    textbox "Card" = "4242" [focused] el_28
    button "Pay now" el_29
```

Each line is `role "name" = "value" [states] handle`. Roles are the implicit ARIA roles plus `heading`, landmarks (`banner`, `navigation`, `main`, `complementary`, `contentinfo`, `form`, `dialog`, `table`), `iframe`, `text` (an element with its own text), and `clickable` (an `onclick` or `tabindex` element without a role). States are `h1`–`h6`, `checked`, `mixed`, `disabled`, `expanded`/`collapsed`, `selected`, `pressed`, `required`, `invalid`, and `focused`. Values are shown for text fields and selects, never for password fields or fields whose name looks like a token or secret. Hidden elements are left out. Controls, links, and images are leaves; a label's text isn't repeated as its own line.

Child frames, same-origin or cross-origin, appear under their `iframe` line; `frames` lists them with `context` and `url`.

Handles are stable: the same element keeps its `el_N` across snapshots (and `screenshot` marks) until the tab's top document changes. Every element action accepts it as `handle`. A handle is bound to the element itself, so siblings appearing or disappearing don't break it; an action fails with "Stale element handle" once the element is gone, or its tag, role, or name changed since the last snapshot or inspect.

The first snapshot of a document returns `mode: "full"` and `tree`. Later ones with the same `root` and `maxNodes` return `mode: "diff"`:

```
~ textbox "Card" [invalid] el_3
+ text "Card declined" el_6
- text "Ready" el_5
```

`~` is a changed line, `+` a new one, `-` one that's gone (with its last text); `unchanged` counts the rest. An empty `diff` means nothing changed. `full: true` returns the whole tree again; navigation starts over. `tokens` gives rough sizes (characters / 4) of the full tree and the diff.

`maxNodes` defaults to 400 (at most 2000); `truncated: true` means the page had more.

## Marks

`screenshot` with `marks: true` draws a numbered box over every interactive element in view, iframes included, captures, and removes the boxes. The response adds `marks: [{ n, handle, role, name, box }]`, using the same handles as `snapshot`. `box` is in CSS pixels of the image: viewport coordinates, or document coordinates with `fullPage: true`. Marks don't combine with an element target.

The boxes live in a closed shadow root appended to each frame's document for the capture only; page scripts can see the host element for that moment.

## Frames

`inspect`, `query`, `snapshot`, marks, and selector/text waits cover every frame of the tab. Firefox gives each iframe its own browsing context, so cross-origin frames are read through that context instead of the parent's DOM. An element from a child frame carries `frame: { context, url }`; its handle acts inside that frame (clicks, fills, field state, element screenshots). `inspect` lists the child frames as `frames: [{ context, url, documentId, parent }]`; pass one as `locator.frame` to resolve a selector or role in that frame. A `locator.frame` that isn't part of the tab is refused.

Waits: `visible` holds as soon as any frame matches, `hidden` once no frame does. Child frames are checked about every 300 ms.

## Downloads

The first action of a session subscribes to `browsingContext.downloadWillBegin` and `downloadEnd` and calls `browser.setDownloadBehavior` so downloads go to `<data dir>/downloads/<session>/` (`~/.local/share/foxpaw/downloads/…` on Linux) without a dialog. The setting is browser-wide while the session runs, so the user's own downloads in that browser land there too; it's reset when the session ends.

- `wait_download` `{ tabId, timeoutMs? }`: call it right after the action that starts a download. It returns the first download that tab started after that action began, once it completes or is canceled: `{ download: { id, tabId, url, suggestedFilename, state, path, startedAt, endedAt } }`. Each download is returned once. It fails with `waitCompleted: false` if none starts, or none finishes, within `timeoutMs` (default 10000).
- `downloads` `{ tabId? }`: this session's downloads (all tabs, or one), with `state` `in_progress`, `complete`, or `canceled`, and the directory in use.

Builds without `browser.setDownloadBehavior` still track downloads; they go where the browser puts them, and `downloads` says so in `note`. Builds without the download events report that in `reason`, and `wait_download` fails with it.

Settings (`downloads` key of the [settings file](../README.md)):

```json
{ "downloads": { "redirect": true, "directory": "/home/me/agent-downloads" } }
```

- `redirect` (default `true`): `false` leaves the browser's download behavior alone and only tracks downloads.
- `directory`: where redirected downloads go instead of the per-session directory.
