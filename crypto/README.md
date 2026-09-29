# meadow-crypto

A thin WebAssembly binding over [vodozemac](https://github.com/matrix-org/vodozemac),
the audited Rust implementation of Olm and Megolm. It exposes only what Meadow's
end-to-end encryption uses (SPEC §8): an Olm account with a fallback key, Olm
sessions, and Megolm outbound and inbound group sessions. It adds no
cryptography of its own; every operation is a direct call into vodozemac.

vodozemac ships no official JavaScript binding, so Meadow keeps this one small
and pinned rather than depending on a third-party wrapper.

## Versions

- vodozemac `=0.11.0`, default features off, session configuration **version 1**
  for both Olm and Megolm. vodozemac's version 2 configurations are behind its
  `experimental-session-config` feature, so they are not used.
- wasm-bindgen `=0.2.129`, matching the CLI in the `Dockerfile`.
- Rust `1.98.1` (the `Dockerfile`'s base image).
- `Cargo.lock` is committed. The conformance vectors in
  `conformance/vectors/e2e/` were generated with exactly these versions.

## Building

Nothing needs Rust on the host. From the repository root:

```bash
npm run crypto:build
```

That runs `docker build --output type=local,dest=crypto/pkg crypto`, which
writes `crypto/pkg/`: `meadow_crypto.js` (CommonJS glue for Node),
`meadow_crypto_bg.wasm`, TypeScript declarations, and the `Cargo.lock` the build
used. `pkg/` is committed, so `npm test` runs without building.

## Using it

```js
import { createRequire } from 'node:module';
const w = createRequire(import.meta.url)('./crypto/pkg/meadow_crypto.js');

const account = new w.Account();
const bundle = { curve25519: account.curve25519Key, fallback: account.generateFallbackKey() };

const group = new w.GroupSession();
const ownCopy = group.inboundCopy(); // take it now: a later copy cannot export earlier indexes
const ciphertext = group.encrypt('hello');
```

`conformance/tools/e2e.js` is the reference use of every function, against the
rules of SPEC §8.
