# bench

Fixture sites, tasks, and runners for foxpaw's benchmarks. See [docs/benchmarks.md](../docs/benchmarks.md).

```sh
bun bench/run.ts                                              # deterministic suite, real headless browser
bun bench/agent.ts --model MODEL --server foxpaw              # LLM agent benchmark: ANTHROPIC_API_KEY, or --harness claude-code
nix build path:.#checks.x86_64-linux.vm -L                    # deterministic suite in a NixOS VM
```

| file | |
|---|---|
| `fixtures/server.ts` | the fixture sites on two loopback origins; logs every request |
| `tasks.ts` | goals, scripted tool calls, allowed side effects, and checks |
| `env.ts` | the throwaway environment (temp dirs, random ports, profile, foxpaw config) and browser launch |
| `approver.ts` | foxpaw's approval command during runs |
| `run.ts` | deterministic suite |
| `agent.ts` | agent loop over an MCP stdio server |
| `results/` | output, not committed |

Typecheck: `bunx tsc --noEmit -p bench`.
