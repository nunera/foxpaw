#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brokerSessionUrl, firefoxBidiBrokerUrl, firefoxBidiUrl } from './config.ts';
import { BrokerBidiClient, ensureBroker } from './broker-client.ts';
import { ZenBrowser } from './browser.ts';
import { AUTOCONFIG, browserAppDir, defaultProfileDir, findBrowser, installAutoconfig, isListening, launchBrowser, profileLockOwner, type LaunchOptions } from './launch.ts';
import { runBroker } from './broker.ts';
import { runMcp } from './mcp/run.ts';
import { policyCommand, secretsCommand } from './trust/commands.ts';
import { logCommand } from './audit/log.ts';
import { recordCommand, replayCommand } from './audit/replay.ts';
import { humanLoopStatus, leasesCommand, pauseCommand, resumeCommand } from './human/commands.ts';

/**
 * Setup and service commands. Each takes the arguments after its name. Features add theirs here (one entry each);
 * anything not listed is a page command (see `page`).
 */
const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  launch: async (args) => print(await launchBrowser(launchOptions(args))),
  ensure: async (args) => {
    const json = args.includes('--json');
    const rest = args.filter((arg) => arg !== '--launch' && arg !== '--json');
    if (args.includes('--launch')) await launchBrowser(launchOptions(rest));
    const endpoint = await ensureBroker(firefoxBidiBrokerUrl());
    // --json keeps the token out of the URL, for clients that can send `Authorization: Bearer` (preferred).
    if (json) print({ url: brokerSessionUrl(), token: endpoint.token ?? null, authorization: endpoint.token ? `Bearer ${endpoint.token}` : null });
    else console.log(endpoint.sessionUrl);
  },
  broker: async () => { await runBroker(); },
  mcp: runMcp,
  status: async () => print(await status()),
  autoconfig: async (args) => autoconfig(args),
  policy: policyCommand,
  secrets: secretsCommand,
  log: async (args) => logCommand(args),
  record: async (args) => recordCommand(args),
  replay: replayCommand,
  pause: pauseCommand,
  resume: resumeCommand,
  leases: leasesCommand,
  help: async () => console.log(usage()),
};

const [command = 'help', ...args] = process.argv.slice(2);

try {
  const run = COMMANDS[command === '--help' || command === '-h' ? 'help' : command];
  if (run) await run(args);
  else await page(command, args);
} catch (error) {
  console.error(`foxpaw: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function launchOptions(flags: string[]): LaunchOptions {
  const options: LaunchOptions = {};
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    const value = () => { const next = flags[++index]; if (!next) throw new Error(`${flag} needs a value`); return next; };
    if (flag === '--dynamic') options.mode = 'dynamic';
    else if (flag === '--headless') options.headless = true;
    else if (flag === '--browser') options.browser = value();
    else if (flag === '--profile') options.profile = value();
    else throw new Error(`Unknown option ${flag}\n\n${usage()}`);
  }
  return options;
}

async function status() {
  const bidi = new URL(firefoxBidiUrl());
  const broker = new URL(firefoxBidiBrokerUrl());
  const browser = findBrowser();
  const profile = process.env.FIREFOX_BIDI_PROFILE ?? defaultProfileDir();
  const appDir = browser ? browserAppDir(browser) : undefined;
  return {
    browser: browser ?? null,
    // null: the executable is a wrapper (Nix, Flatpak) whose install directory can't be found from here.
    autoconfigInstalled: appDir ? existsSync(join(appDir, 'foxpaw.cfg')) : null,
    profile,
    profileOpenBy: profileLockOwner(profile) ?? null,
    remoteControl: { url: bidi.toString(), listening: await isListening(Number(bidi.port || 9222)) },
    broker: { url: brokerSessionUrl(), listening: await isListening(Number(broker.port || 9223)) },
    // null: no broker runs. Otherwise {paused, since?, by?, leasedTabs}.
    humanLoop: await humanLoopStatus(),
  };
}

function autoconfig(rest: string[]): void {
  const [sub, dir] = rest;
  if (sub === 'print') { process.stdout.write(AUTOCONFIG.cfg); return; }
  if (sub !== 'install') throw new Error('Usage: foxpaw autoconfig install [browser-install-dir] | foxpaw autoconfig print');
  const browser = findBrowser();
  const appDir = dir ?? (browser ? browserAppDir(browser) : undefined);
  if (!appDir) throw new Error(`Can't find the install directory (the one with omni.ja) of ${browser ?? 'any browser'}; pass it. On Nix, use the flake's lib.withRemoteControl instead (see README).`);
  for (const file of installAutoconfig(appDir)) console.log(file);
}

async function page(name: string, rest: string[]): Promise<void> {
  // Through the broker, so the CLI shares the browser's one session with agents and programs instead of competing.
  const browser = new ZenBrowser(new BrokerBidiClient());
  const target = async () => (await browser.target(rest[0]!)).id;
  try {
    switch (name) {
      case 'tabs': print(await browser.contexts()); break;
      case 'open': need('open <url>', 1); print(await browser.open(rest[0]!)); break;
      case 'navigate': need('navigate <target> <url>', 2); await browser.navigate(await target(), rest[1]!); break;
      case 'activate': need('activate <target>', 1); await browser.activate(await target()); break;
      case 'close': need('close <target>', 1); await browser.close(await target()); break;
      case 'click': need('click <target> <selector>', 2); await browser.click(await target(), rest[1]!); break;
      case 'fill': need('fill <target> <selector> <value>', 3); await browser.fill(await target(), rest[1]!, rest[2]!); break;
      case 'type': need('type <target> <selector> <text>', 3); await browser.type(await target(), rest[1]!, rest[2]!); break;
      case 'press': need('press <target> <key> [selector]', 2); await browser.press(await target(), rest[1]!, rest[2]); break;
      case 'scroll': {
        need('scroll <target> <dx> <dy>', 3);
        const dx = Number(rest[1]);
        const dy = Number(rest[2]);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Scroll deltas must be finite numbers');
        await browser.scroll(await target(), dx, dy);
        break;
      }
      case 'select': need('select <target> <selector> <value>', 3); await browser.select(await target(), rest[1]!, rest[2]!); break;
      case 'check': need('check <target> <selector> <true|false>', 3); await browser.check(await target(), rest[1]!, rest[2] === 'true'); break;
      case 'upload': need('upload <target> <selector> <file...>', 3); await browser.upload(await target(), rest[1]!, rest.slice(2)); break;
      case 'wait-for': need('wait-for <target> <selector>', 2); await browser.waitFor(await target(), rest[1]!); break;
      case 'wait-url': need('wait-url <target> <url-fragment>', 2); await browser.waitForUrl(await target(), rest[1]!); break;
      case 'evaluate': need('evaluate <target> <expression>', 2); print(await browser.evaluate(await target(), rest[1]!)); break;
      case 'screenshot': {
        need('screenshot <target> <output.png>', 2);
        await writeFile(rest[1]!, Buffer.from(await browser.screenshot(await target()), 'base64'));
        break;
      }
      default:
        console.error(usage());
        process.exitCode = 2;
    }
  } finally {
    await browser.bidi.close();
  }

  function need(syntax: string, count: number): void {
    if (rest.length < count) throw new Error(`Usage: foxpaw ${syntax}`);
  }
}

function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }

function usage(): string {
  return `Usage: foxpaw <command>

Setup:
  launch [--dynamic] [--headless] [--browser PATH] [--profile DIR]
                      Start a Zen or Firefox foxpaw can drive, next to your everyday browser.
                      Default profile: ${defaultProfileDir()}. --dynamic starts remote control
                      from inside the browser (needs the AutoConfig), so pages don't see navigator.webdriver.
  ensure [--launch ...] [--json]
                      Start the broker if needed and print its plain WebDriver BiDi URL with the token
                      (${brokerSessionUrl()}?token=…). --json prints the URL and the token separately,
                      for clients that can send it as Authorization: Bearer (keeps it out of URLs).
                      --launch also starts the browser (takes launch's options).
  broker              Run the broker in the foreground.
  mcp [--http [--port N]]
                      Serve the zen_browser tool to MCP hosts over stdio, or Streamable HTTP on
                      127.0.0.1 (default port 9224) with a bearer token. See docs/mcp.md.
  status              Show the browser, profile, remote-control port, and broker.
  autoconfig install [dir] | autoconfig print
                      Copy the AutoConfig that --dynamic needs into the browser's install directory.

Trust (see docs/policy.md, docs/secrets.md):
  policy show | policy check <url> <action>
                      Print the effective policy, or the decision for an action on a URL.
  secrets list | secrets check <name>
                      List configured secrets, or check one resolves (never prints values).

Audit (see docs/audit.md):
  log [--since 2h|2026-11-26] [--session ID] [--tab tab_3] [--action click] [--json] [--follow]
                      Show what agents did in the browser (today by default).
  record --session ID [--from N] [--to N] -o script.json
                      Turn a session's successful page-changing actions into a replayable script.
  replay script.json [--dry-run] [--tab-url substring] [--var NAME=VALUE ...]
                      Run a script in a fresh tab (or the one tab matching --tab-url).

Human loop (see docs/human-loop.md):
  pause | resume      Hold every agent's input, navigation, and script commands until resumed
                      (also Ctrl+Alt+P in an agent-controlled tab). status shows the state.
  leases              Show which agent controls which tab.

Pages (targets are unique URL or title substrings; runs through the broker):
  tabs
  open <url>
  activate <target>
  close <target>
  navigate <target> <url>
  click <target> <selector>
  fill <target> <selector> <value>
  type <target> <selector> <text>
  press <target> <key> [selector]
  scroll <target> <dx> <dy>
  select <target> <selector> <value>
  check <target> <selector> <true|false>
  upload <target> <selector> <file...>
  wait-for <target> <selector>
  wait-url <target> <url-fragment>
  evaluate <target> <expression>
  screenshot <target> <output.png>

Selectors accept CSS and composed shadow-DOM paths such as yt-searchbox >>> textarea.`;
}
