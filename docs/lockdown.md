# Giving an agent the browser and nothing else

foxpaw's policy, secrets, and audit log live in the `zen_browser` tool. They hold as long as the tool is the only way the agent can reach the browser. An agent that can also run shell commands as you can step around them: read the broker token and talk to the broker directly, or edit `~/.config/foxpaw/config.json` to allow everything. Most coding agents have a shell by default.

So for a task you don't fully trust (reading email, anything on a site that could carry a prompt injection, anything with money or accounts on the line), run the agent with the browser tool and without these:

| Capability | Why it matters |
| --- | --- |
| Running commands (bash, shell, terminal) | Reads the token, connects to the broker, rewrites the config |
| Running code (Python or JS evaluation, notebooks) | Same as a shell |
| Writing or editing files outside a project folder | Rewrites `config.json` to allow everything |
| Subagents that have any of the above | They inherit what the parent couldn't do |

Reading files is less dangerous: the token alone gets the agent nothing without a way to open a WebSocket. Keep it to the project folder anyway.

## Claude Code

`--tools ""` removes every built-in tool (Bash, file edits, web fetch, and the rest) and leaves MCP tools alone:

```sh
claude --tools "" --allowedTools "mcp__foxpaw__zen_browser"
```

`--allowedTools` only stops the per-call permission prompt for foxpaw; it doesn't add anything. To also drop every other MCP server for the session, add `--strict-mcp-config --mcp-config '{"mcpServers":{"foxpaw":{"command":"foxpaw","args":["mcp"]}}}'`. See Claude Code's [CLI reference](https://code.claude.com/docs/en/cli-reference) for `--tools` and `--disallowedTools`.

## Codex

Codex runs its shell inside a sandbox. Start it read-only and keep approvals on, so every command waits for you:

```sh
codex --sandbox read-only --ask-for-approval on-request
```

Then don't approve commands that touch `~/.config/foxpaw`, `$XDG_RUNTIME_DIR/foxpaw`, or `127.0.0.1:9223`. Codex's sandbox is a boundary for files and the network in general; whether it blocks loopback connections depends on the platform, so treat the approval as the real control.

## oh-my-pi

Start omp with only the tools you want, then check the session's tool list before giving it the task:

```sh
omp --tools read,zen_browser
```

The list must not include `bash`, `eval`, `edit`, `write`, or `task`. `bash.enabled: false` and `eval.py`/`eval.js: false` in omp's settings make it permanent for a profile.

## Any other MCP host

Turn off the host's terminal or shell tool and its file-editing tool, and allow only the `zen_browser` tool from foxpaw. If the host can't do that, assume the agent can reach everything you can.

## What this doesn't cover

A program running as you can still do anything you can, including everything above, regardless of what any agent is allowed to call. foxpaw's broker token stops web pages and other users on the machine, not your own processes. The fix for that is running the browser and broker as a separate user, which foxpaw doesn't do yet.
