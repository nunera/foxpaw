import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import type { z as Zod } from 'zod';
import { createBrowserTool, type ToolParams } from '../src/tool/core.ts';
import { defaultFeatures } from '../src/tool/features/index.ts';

// The oh-my-pi host passes its own zod (pi.zod), possibly zod 3; the tool sticks to APIs both versions share.
export default function registerZenBrowser(pi: ExtensionAPI) {
  const tool = createBrowserTool(pi.zod as unknown as typeof Zod, { features: defaultFeatures() });
  pi.on('session_shutdown', () => tool.shutdown());
  pi.registerTool({
    name: tool.name,
    label: tool.label,
    loadMode: 'essential',
    description: tool.description,
    parameters: tool.parameters,
    execute: (_id, params, signal) => tool.execute(params as ToolParams, signal),
  });
}
