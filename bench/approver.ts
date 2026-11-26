import { appendFileSync, readFileSync } from 'node:fs';

/**
 * foxpaw's `approval.command` during benchmarks: logs the approval request (one JSON line) to the file in argv[2] and
 * answers with argv[3], `approve` (exit 0) or `deny` (exit 1). It stands in for the user, who knows which
 * irreversible actions they asked for.
 */
const [log, decision] = process.argv.slice(2);
if (!log || (decision !== 'approve' && decision !== 'deny')) {
  console.error('Usage: approver.ts <log-file> approve|deny');
  process.exit(2);
}
appendFileSync(log, `${readFileSync(0, 'utf8').trim()}\n`);
process.exit(decision === 'approve' ? 0 : 1);
