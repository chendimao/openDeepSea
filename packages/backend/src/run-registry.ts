export type RunAbortReason = 'cancelled' | 'paused';

const controllers = new Map<string, AbortController>();
const abortReasons = new Map<string, RunAbortReason>();

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
    return this.abort(runId, 'cancelled');
  },

  pause(runId: string): boolean {
    return this.abort(runId, 'paused');
  },

  abort(runId: string, reason: RunAbortReason): boolean {
    const controller = controllers.get(runId);
    if (!controller) return false;
    abortReasons.set(runId, reason);
    controller.abort(reason);
    return true;
  },

  getAbortReason(runId: string): RunAbortReason | undefined {
    return abortReasons.get(runId);
  },

  remove(runId: string): void {
    controllers.delete(runId);
    abortReasons.delete(runId);
  },
};
