// What caused a payment (SPEC §16.9.4): a tool call (and which), the background
// sync, the person's Sync Now, MessageGuard, or the runner. Set where the work
// begins and read where the payment is signed, through the async call chain,
// so nothing in between has to pass it along.

import { AsyncLocalStorage } from 'node:async_hooks';

/** `tool:<name>`, `background`, `person`, `runner`, or `messageguard`. */
export type Cause = string;

const store = new AsyncLocalStorage<Cause>();

/** Runs `fn` with `cause` as the cause of any payment it makes. */
export function withCause<T>(cause: Cause, fn: () => T): T {
  return store.run(cause, fn);
}

/** The cause of a payment being signed now; `app` when nothing set one. */
export function currentCause(): Cause {
  return store.getStore() ?? 'app';
}
