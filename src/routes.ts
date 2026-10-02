import { type BidiTransport, type BidiEvent, type JsonObject } from './bidi.ts';

export type RouteDefinition = {
  url: string;
  phases: Array<'beforeRequestSent' | 'responseStarted'>;
  action: 'continue' | 'abort' | 'fulfill';
  headers?: Record<string, string>;
  status?: number;
  body?: string;
};

type InstalledRoute = RouteDefinition & { intercept: string };

export class RouteManager {
  #routes = new Map<string, InstalledRoute>();
  #unsubscribe: () => void;

  constructor(readonly bidi: BidiTransport) {
    this.#unsubscribe = bidi.onEvent((event) => { void this.#handle(event); });
  }

  async add(route: RouteDefinition): Promise<string> {
    const result = await this.bidi.commandOptional('network.addIntercept', {
      phases: route.phases,
      urlPatterns: [{ type: 'string', pattern: route.url }],
    });
    if (typeof result.intercept !== 'string') throw new Error('Firefox did not return an interception ID');
    this.#routes.set(result.intercept, { ...route, intercept: result.intercept });
    await this.bidi.subscribe(route.phases.map((phase) => `network.${phase}`));
    return result.intercept;
  }

  async remove(intercept: string): Promise<void> {
    const route = this.#routes.get(intercept);
    if (!route) return;
    this.#routes.delete(intercept);
    await this.bidi.commandOptional('network.removeIntercept', { intercept });
  }

  list(): Array<{ intercept: string; route: RouteDefinition }> {
    return [...this.#routes.values()].map(({ intercept, ...route }) => ({ intercept, route }));
  }

  async close(): Promise<void> {
    const intercepts = [...this.#routes.keys()];
    await Promise.all(intercepts.map((intercept) => this.remove(intercept)));
    this.#unsubscribe();
  }

  async #handle(event: BidiEvent): Promise<void> {
    const phase = event.method === 'network.beforeRequestSent' ? 'beforeRequestSent' : event.method === 'network.responseStarted' ? 'responseStarted' : undefined;
    if (!phase) return;
    const request = event.params.request;
    if (!request || typeof request !== 'object' || !('request' in request) || typeof request.request !== 'string') return;
    const intercepts = Array.isArray(event.params.intercepts) ? event.params.intercepts.filter((item): item is string => typeof item === 'string') : [];
    for (const intercept of intercepts) {
      const route = this.#routes.get(intercept);
      if (!route || !route.phases.includes(phase)) continue;
      if (route.action === 'continue') await this.bidi.commandOptional('network.continueRequest', { request: request.request });
      else if (route.action === 'abort') await this.bidi.commandOptional('network.failRequest', { request: request.request });
      else await this.bidi.commandOptional('network.provideResponse', {
        request: request.request,
        response: {
          statusCode: route.status,
          headers: Object.entries(route.headers ?? {}).map(([name, value]) => ({ name, value })),
          body: { type: 'base64', value: Buffer.from(route.body ?? '').toString('base64') },
        },
      });
    }
  }
}
