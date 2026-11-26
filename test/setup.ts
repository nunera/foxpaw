import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Preloaded for every test (bunfig.toml): nothing a test does may read the user's config or touch their audit log,
// profile, downloads, or broker tokens. Tests that need their own directories still set them explicitly.
const root = mkdtempSync(join(tmpdir(), 'foxpaw-test-'));
process.env.FOXPAW_CONFIG = join(root, 'config.json');
process.env.XDG_CONFIG_HOME = join(root, 'config');
process.env.XDG_STATE_HOME = join(root, 'state');
process.env.XDG_DATA_HOME = join(root, 'data');
process.env.XDG_RUNTIME_DIR = mkdtempSync(join(root, 'run-'));
