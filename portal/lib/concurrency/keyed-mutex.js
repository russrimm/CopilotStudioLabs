/**
 * A per-key async mutex: callers with the same key run one at a time, in the order they asked; different keys never wait
 * for each other. Use it around a read, an `await`, and a write on the same file or record, so the write cannot be based
 * on a read that another request has since replaced. Purely synchronous read-and-write code needs no mutex: Node runs it
 * without interruption.
 */

export function createKeyedMutex() {
  const tails = new Map();

  /** Run `work` after every earlier call for `key` has finished. A failure in one call never blocks the next. */
  function run(key, work) {
    const previous = tails.get(key) || Promise.resolve();
    const result = previous.then(() => work());
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  }

  return { run, size: () => tails.size };
}

/** The portal-wide mutex, for stores that do not need one of their own. */
export const sharedMutex = createKeyedMutex();
