# MCP server

`foxpaw mcp` serves the `zen_browser` tool to any [Model Context Protocol](https://modelcontextprotocol.io) host: Claude Code, Codex, Cursor, and anything else that speaks MCP. It's the same tool the oh-my-pi extension registers, with the same actions and safeguards (see [zen-browser-tool.md](zen-browser-tool.md)), and it goes through the same broker, so MCP hosts, oh-my-pi, and the CLI share one browser session.

The host starts `foxpaw mcp` itself and talks to it over stdio. If no browser foxpaw can drive is running, the agent calls the `launch` action; then `tabs`.

From a checkout instead of an installed `foxpaw`, use `bun /path/to/foxpaw/src/cli.ts mcp` as the command.

## Claude Code

```sh
claude mcp add foxpaw -- foxpaw mcp
```

## Codex

```sh
codex mcp add foxpaw -- foxpaw mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.foxpaw]
command = "foxpaw"
args = ["mcp"]
```

Codex stops waiting for a tool after 60 seconds by default; add `tool_timeout_sec = 300` (or more) if the agent uses long `timeoutMs` waits.

## Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "foxpaw": { "command": "foxpaw", "args": ["mcp"] }
  }
}
```

## Other hosts

Most hosts take the same shape: a command, its arguments, and optionally environment variables.

```json
{
  "mcpServers": {
    "foxpaw": {
      "command": "foxpaw",
      "args": ["mcp"],
      "env": { "FIREFOX_BIDI_BROKER_URL": "ws://127.0.0.1:9223" }
    }
  }
}
```

The environment variables are the ones the rest of foxpaw reads (`FIREFOX_BIDI_URL`, `FIREFOX_BIDI_BROKER_URL`, `FIREFOX_BIDI_BROWSER`, `FIREFOX_BIDI_PROFILE`, …); none are needed for the defaults.

On stdio, stdout carries only JSON-RPC; foxpaw's own messages go to stderr. The server exits when the host closes its stdin.

## HTTP

For hosts that connect to a URL rather than start a command, or to share one server between several hosts:

```sh
foxpaw mcp --http              # http://127.0.0.1:9224/mcp
foxpaw mcp --http --port 9300  # another port; --port 0 picks a free one
```

This is MCP's Streamable HTTP transport (protocol 2025-06-18). It listens on 127.0.0.1 only and runs until Ctrl-C. At start it prints its URL and a token on stderr:

```
foxpaw MCP server: http://127.0.0.1:9224/mcp
Authorization: Bearer 3q2-…
Token file: /run/user/1000/foxpaw/mcp-9224.token
```

Every request must carry the token, as `Authorization: Bearer <token>` (what MCP hosts send) or `?token=<token>` in the URL. Like the broker, the server also refuses any request with an `Origin` header (web pages) and any `Host` that isn't loopback (DNS rebinding), so a website can't reach it. The token is new at every start and saved readable only by you; it's removed when the server stops. Pick it up from the token file when you configure a host, for example:

```sh
export FOXPAW_MCP_TOKEN="$(cat "$XDG_RUNTIME_DIR/foxpaw/mcp-9224.token")"
claude mcp add --transport http foxpaw http://127.0.0.1:9224/mcp --header "Authorization: Bearer $FOXPAW_MCP_TOKEN"
```

Codex reads the token from an environment variable:

```toml
[mcp_servers.foxpaw]
url = "http://127.0.0.1:9224/mcp"
bearer_token_env_var = "FOXPAW_MCP_TOKEN"
```

Cursor and generic JSON configs:

```json
{
  "mcpServers": {
    "foxpaw": {
      "url": "http://127.0.0.1:9224/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Without `XDG_RUNTIME_DIR` (macOS, Windows), the token file is in a per-user directory in the system temp dir; the path printed at start is the one to use.

Protocol details, for client authors: `POST /mcp` carries one JSON-RPC message (no batches). `initialize` returns an `Mcp-Session-Id` header that every later request must send; an unknown or ended session gets 404, a missing one 400. Responses are JSON, or a single-event SSE stream for a client whose `Accept` lists only `text/event-stream`. Notifications get 202. `DELETE /mcp` ends the session; `GET /mcp` is 405 because the server never sends unrequested messages.

## What the host sees

One tool, `zen_browser`, whose input schema is the JSON Schema of the tool's parameters (`action` plus the per-action fields). Results are a JSON text block, plus a PNG image block for `screenshot`. Arguments that don't fit the schema, and actions that fail, come back as tool results with `isError: true` and the reason, so the agent can read it and correct the call. Cancelling a call in the host (`notifications/cancelled`) aborts it if it hasn't reached the browser yet.
