// Reading a remote reply with a size limit (SPEC §11.1, §11.2). `res.json()`
// buffers a body of any size, so a hostile peer could make a node hold as
// much as it can send before the timeout. This reads the stream and stops
// past the limit.

export const REPLY_LIMITS = {
  hello: 64 * 1024,
  peer: 4 * 1024 * 1024,
  lcdPage: 8 * 1024 * 1024,
};

export class ReplyTooLarge extends Error {
  constructor(limit) {
    super(`reply over ${limit} bytes`);
    this.limit = limit;
  }
}

/** The reply's JSON, read up to `maxBytes`; throws ReplyTooLarge past it, and a SyntaxError on bad JSON. */
export async function readJson(res, maxBytes) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel?.().catch(() => {});
    throw new ReplyTooLarge(maxBytes);
  }
  if (!res.body) return JSON.parse(await res.text());
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ReplyTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
