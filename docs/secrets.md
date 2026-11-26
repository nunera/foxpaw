# Secrets

`fill_secret` types a password, PIN, or token into a field without the agent ever passing or seeing it. You name the secret and say where its value comes from and which sites may receive it; the agent only knows the name.

```json
{ "action": "fill_secret", "tabId": "tab_2", "selector": "#password", "secret": "bank" }
```

returns `{ "tabId": "tab_2", "filled": true, "secret": "bank", "selector": "#password" }`.

## Configuration

The `secrets` key in foxpaw's config file (`~/.config/foxpaw/config.json`; `FOXPAW_CONFIG` overrides):

```json
{
  "secrets": {
    "bank": { "source": "pass:web/bank.example", "origins": ["https://bank.example", "https://login.bank.example"] },
    "github-token": { "source": "op:op://Private/GitHub/token", "origins": ["https://github.com"] },
    "pin": { "source": "bitwarden:Bank/pin", "origins": ["https://bank.example"] },
    "wifi": { "source": "keyring:router/admin", "origins": ["http://192.168.1.1"] },
    "test": { "source": "env:TEST_PASSWORD", "origins": ["http://127.0.0.1:8080"] }
  }
}
```

| source | reads |
|---|---|
| `pass:<path>` | first line of `pass show <path>` |
| `bitwarden:<item>` | `bw get password <item>` (needs an unlocked session, `BW_SESSION`) |
| `bitwarden:<item>/<field>` | `bw get <field> <item>` for `username`, `totp`, `notes`, `uri`; otherwise the custom field with that name |
| `op:<op://vault/item/field>` | `op read` |
| `keyring:<service>/<account>` | `secret-tool lookup service … account …` on Linux, `security find-generic-password -s … -a … -w` on macOS |
| `env:<VARIABLE>` | the environment of the process running the tool |

The value is read when the agent asks for it, inside foxpaw, and goes only into the page field.

Check a secret resolves (prints no value):

```sh
foxpaw secrets list
foxpaw secrets check bank
```

## What is refused

`fill_secret` fills nothing unless:

- the secret name is configured,
- both the tab's page and the field's own frame are on one of the secret's `origins` (a page that tells the agent to "log in" on another site, or a foreign iframe on an allowed page, gets nothing),
- the target is an `input` or `textarea`, and the page didn't change between the check and the fill.

After a fill, the tab is in secret mode until its document is replaced (a navigation; `pushState` doesn't count):

- `evaluate` is refused.
- `screenshot` is refused unless every field holding a secret is still `type=password`.
- `assert` on `value` is refused (it would let the agent guess the value).

## Redaction

From the first fill on, every result and error of every action on every tab has the value replaced with `[secret:<name>]`: raw, URL-encoded, form-encoded, HTML-escaped, and JSON-escaped. That covers pages that echo the value back (`field_state`, `query`, `inspect`, a "you entered …" page, a redirect URL). It lasts until the tool shuts down.

Page script can transform a value in ways redaction can't follow (reversed, base64), which is why secret mode refuses `evaluate`; after the page navigates, `evaluate` runs again and only exact forms are redacted. The audit log records the secret's name, never its value.

`fill_secret` is a write for [policy](policy.md), so a site that asks for writes asks before a secret is filled. Secret-mode refusals are checked before policy, so a refused `evaluate` or screenshot never prompts you first.
