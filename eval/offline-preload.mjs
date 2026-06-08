/**
 * Eval-owned preload (NOT project source).
 *
 * Enforces the "offline / isolated store" requirement deterministically: it
 * neutralizes outbound network so the server can only use its offline
 * extractive path, regardless of the test machine's connectivity. This makes
 * the stdio-driven criteria reproducible (no dependence on whether a given
 * video happens to have public captions today).
 *
 * Loaded via:  node --import ./eval/offline-preload.mjs server.js
 */

const offlineError = () =>
  Object.assign(new Error('offline (eval isolation): network disabled'), {
    name: 'TypeError',
  });

// Disable global fetch (undici) — every outbound request rejects immediately.
globalThis.fetch = async () => { throw offlineError(); };
