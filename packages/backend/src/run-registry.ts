const controllers = new Map<string, AbortController>();

export const runRegistry = {
  create(runId: string): AbortController {
    const controller = new AbortController();
    controllers.set(runId, controller);
    return controller;
  },

  get(runId: string): AbortController | undefined {
    return controllers.get(runId);
  },

  cancel(runId: string): boolean {
    const controller = controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  },

  remove(runId: string): void {
    controllers.delete(runId);
  },
};
