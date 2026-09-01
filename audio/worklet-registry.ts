/**
 * Worklet module registry
 *
 * A worklet module must be added to an AudioContext exactly once: the players
 * inline their processor code in a fresh Blob URL, so a second addModule
 * re-evaluates the module in the same AudioWorkletGlobalScope and
 * registerProcessor throws "already registered". Registration is keyed per
 * (context, processor name) and shares the in-flight promise so concurrent
 * inits on the same context register once.
 */

const registrations = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();

export function registerWorklet(ctx: BaseAudioContext, processorName: string, code: string): Promise<void> {
  let contextRegistrations = registrations.get(ctx);
  if (!contextRegistrations) {
    contextRegistrations = new Map();
    registrations.set(ctx, contextRegistrations);
  }

  let registration = contextRegistrations.get(processorName);
  if (!registration) {
    registration = addWorkletModule(ctx, code);
    // A failed registration may be retried
    registration.catch(() => contextRegistrations!.delete(processorName));
    contextRegistrations.set(processorName, registration);
  }
  return registration;
}

async function addWorkletModule(ctx: BaseAudioContext, code: string): Promise<void> {
  const blob = new Blob([code], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
