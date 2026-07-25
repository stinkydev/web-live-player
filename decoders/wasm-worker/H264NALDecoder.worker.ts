// @ts-ignore
import { init } from 'tinyh264'

/**
 * tinyh264's worker echoes only `renderStateId` back with a picture, and that field
 * selects the decoder instance, so it can't carry per-frame data. Its decoder invokes
 * the picture callback synchronously inside decode() and produces at most one picture
 * per decode() call, so whichever `decode` message is being handled right now is the
 * one that produced the picture. Stamp its `pts`/`seq` onto the outgoing message so the
 * main thread never has to pair timestamps by position.
 */

let currentPts: number = 0;
let currentSeq: number = 0;

const originalPostMessage: typeof self.postMessage = self.postMessage.bind(self);

// tinyh264 calls the global postMessage, which resolves through this own property
(self as any).postMessage = (message: any, ...rest: any[]): void => {
  if (message && message.type === 'pictureReady') {
    message.pts = currentPts;
    message.seq = currentSeq;
  }
  (originalPostMessage as any)(message, ...rest);
};

// Registered before init() adds tinyh264's listener, so this runs first for each message
self.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (message && message.type === 'decode') {
    currentPts = message.pts ?? 0;
    currentSeq = message.seq ?? 0;
  }
});

init();
