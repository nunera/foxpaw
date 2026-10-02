import { writeFile } from 'node:fs/promises';
import { firefoxBidiUrl } from './config.ts';
import { BidiClient } from './bidi.ts';
import { ZenBrowser } from './browser.ts';

const [command, ...args] = process.argv.slice(2);
const endpoint = firefoxBidiUrl();
const browser = new ZenBrowser(new BidiClient(endpoint));

try {
  switch (command) {
    case 'tabs':
      console.log(JSON.stringify(await browser.contexts(), null, 2));
      break;
    case 'open':
      requireArgs('open <url>', args, 1);
      console.log(JSON.stringify(await browser.open(args[0]!)));
      break;
    case 'navigate':
      requireArgs('navigate <target> <url>', args, 2);
      await browser.navigate((await browser.target(args[0]!)).id, args[1]!);
      break;
    case 'activate':
      requireArgs('activate <target>', args, 1);
      await browser.activate((await browser.target(args[0]!)).id);
      break;
    case 'close':
      requireArgs('close <target>', args, 1);
      await browser.close((await browser.target(args[0]!)).id);
      break;
    case 'click':
      requireArgs('click <target> <selector>', args, 2);
      await browser.click((await browser.target(args[0]!)).id, args[1]!);
      break;
    case 'fill':
      requireArgs('fill <target> <selector> <value>', args, 3);
      await browser.fill((await browser.target(args[0]!)).id, args[1]!, args[2]!);
      break;
    case 'type':
      requireArgs('type <target> <selector> <text>', args, 3);
      await browser.type((await browser.target(args[0]!)).id, args[1]!, args[2]!);
      break;
    case 'press':
      requireArgs('press <target> <key> [selector]', args, 2);
      await browser.press((await browser.target(args[0]!)).id, args[1]!, args[2]);
      break;
    case 'scroll': {
      requireArgs('scroll <target> <dx> <dy>', args, 3);
      const dx = Number(args[1]);
      const dy = Number(args[2]);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Scroll deltas must be finite numbers');
      await browser.scroll((await browser.target(args[0]!)).id, dx, dy);
      break;
    }
    case 'select':
      requireArgs('select <target> <selector> <value>', args, 3);
      await browser.select((await browser.target(args[0]!)).id, args[1]!, args[2]!);
      break;
    case 'check':
      requireArgs('check <target> <selector> <true|false>', args, 3);
      await browser.check((await browser.target(args[0]!)).id, args[1]!, args[2] === 'true');
      break;
    case 'upload':
      requireArgs('upload <target> <selector> <file...>', args, 3);
      await browser.upload((await browser.target(args[0]!)).id, args[1]!, args.slice(2));
      break;
    case 'wait-for':
      requireArgs('wait-for <target> <selector>', args, 2);
      await browser.waitFor((await browser.target(args[0]!)).id, args[1]!);
      break;
    case 'wait-url':
      requireArgs('wait-url <target> <url-fragment>', args, 2);
      await browser.waitForUrl((await browser.target(args[0]!)).id, args[1]!);
      break;
    case 'evaluate':
      requireArgs('evaluate <target> <expression>', args, 2);
      console.log(JSON.stringify(await browser.evaluate((await browser.target(args[0]!)).id, args[1]!), null, 2));
      break;
    case 'screenshot': {
      requireArgs('screenshot <target> <output.png>', args, 2);
      const base64 = await browser.screenshot((await browser.target(args[0]!)).id);
      await writeFile(args[1]!, Buffer.from(base64, 'base64'));
      break;
    }
    default:
      console.error(usage());
      process.exitCode = 2;
  }
} finally {
  await browser.bidi.close();
}

function requireArgs(syntax: string, received: string[], count: number): void {
  if (received.length < count) throw new Error(`Usage: zen-bidi ${syntax}`);
}

function usage(): string {
  return `Usage: bun run start -- <command>

Targets are unique URL or title substrings, resolved inside the active BiDi session.

Commands:
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
