// What caused a payment (SPEC §16.9.4): a tool call (and which), the background
// sync, the person's Sync Now, MessageGuard, or the runner. Set where the work
// begins and read where the payment is signed, through the async call chain,
// so nothing in between has to pass it along.

import { AsyncLocalStorage } from 'node:async_hooks';

/** `tool:<name>`, `background`, `person`, `runner`, or `messageguard`. */
export type Cause = string;

interface Context {
  cause: Cause;
  /** The payments signed inside this work, by seq, when the caller asked to see them. */
  seqs?: number[];
}

const store = new AsyncLocalStorage<Context>();

/** Runs `fn` with `cause` as the cause of any payment it makes. Payments still reach an enclosing tracker. */
export function withCause<T>(cause: Cause, fn: () => T): T {
  return store.run({ cause, seqs: store.getStore()?.seqs }, fn);
}

/**
 * Like withCause, and collects the seq of every payment signed inside `fn` into `seqs`.
 * A call's own cost comes from these, never from a time window: two calls running side by
 * side would each count the other's payment (a tester saw $0.01 reported twice, 2026-10-02).
 */
export function withCauseTracked<T>(cause: Cause, seqs: number[], fn: () => T): T {
  return store.run({ cause, seqs }, fn);
}

/** The cause of a payment being signed now; `app` when nothing set one. */
export function currentCause(): Cause {
  return store.getStore()?.cause ?? 'app';
}

/** Tells the enclosing tracker, if any, that payment `seq` was signed. */
export function notePayment(seq: number) {
  store.getStore()?.seqs?.push(seq);
}
