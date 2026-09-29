// How the core reaches the network (SPEC §16.1, §16.8). The app has one
// transport: the PNF agentic portal, paid per call through the spend guard
// (§16.9, built in step 2). Tests pass an in-process transport in code; there
// is no setting or variable that selects one.

export interface CallResult {
  /** The node's answer: the portal's `data`, unwrapped. A 4xx answer is `{error: {...}}`. */
  status: number;
  data: any;
  /** What the call cost, when it was paid. */
  cost?: { usd: string; wallet: string };
}

export interface Transport {
  /** POSTs `body` to the Meadow endpoint `path` (for example /v2/sync) on behalf of `agent`. */
  call(path: string, body: unknown, agent: string | null): Promise<CallResult>;
}

/**
 * A call that was not made or not completed. `refused` means the spend guard
 * said no, and nothing was sent or paid (§16.9): `message` says why in plain words.
 */
export class TransportError extends Error {
  kind: 'refused' | 'network' | 'http';
  /** A refusal because the terms did not match the catalog, which a fresh catalog may change. */
  catalogMismatch: boolean;
  constructor(kind: 'refused' | 'network' | 'http', message: string, { catalogMismatch = false } = {}) {
    super(message);
    this.kind = kind;
    this.catalogMismatch = catalogMismatch;
  }
}
