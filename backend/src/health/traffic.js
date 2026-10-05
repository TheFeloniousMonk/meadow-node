// Bytes in and out, counted in the process (SPEC §9.6): per server (relay
// port, peer port) from its sockets, and for this node's own calls (peers,
// discovery, the chain API) from their request and response bodies.

export class Traffic {
  #in = 0;
  #out = 0;
  #live = new Map(); // socket -> bytes already counted { read, written }

  add(bytesIn, bytesOut) {
    this.#in += bytesIn;
    this.#out += bytesOut;
  }

  // A server's socket: counted when it closes, and up to now whenever totals are read.
  track(socket) {
    this.#live.set(socket, { read: 0, written: 0 });
    socket.once('close', () => {
      this.#flush(socket);
      this.#live.delete(socket);
    });
  }

  #flush(socket) {
    const seen = this.#live.get(socket);
    if (!seen) return;
    const read = socket.bytesRead ?? 0;
    const written = socket.bytesWritten ?? 0;
    this.add(read - seen.read, written - seen.written);
    seen.read = read;
    seen.written = written;
  }

  /** { in, out } since start, including connections still open. */
  totals() {
    for (const socket of this.#live.keys()) this.#flush(socket);
    return { in: this.#in, out: this.#out };
  }
}

/** Counts every connection a server accepts. */
export function countServer(server, traffic) {
  server.on('connection', (socket) => traffic.track(socket));
  return server;
}

const bodyBytes = (body) => (typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body?.byteLength ?? 0);

/** A fetch that counts request and response bodies into `traffic` (bodies only, not headers). */
export function countingFetch(fetch, traffic) {
  return async (url, init = {}) => {
    traffic.add(0, bodyBytes(init.body));
    const res = await fetch(url, init);
    if (!res.body) return res;
    const counted = res.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        traffic.add(chunk.byteLength, 0);
        controller.enqueue(chunk);
      },
    }));
    return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
