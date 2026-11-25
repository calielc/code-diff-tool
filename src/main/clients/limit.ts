/** At most this many changes are read at the same time. The whole read of one change holds one slot. */
export const SNAPSHOT_CONCURRENCY = 6

export type Limiter = <T>(call: () => Promise<T>) => Promise<T>

/** Runs a call when a slot is free. A call that finishes or fails hands its slot to the next one that waits. */
export function createLimiter(max: number): Limiter {
  let running = 0
  const waiting: (() => void)[] = []
  return async <T>(call: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    else running++
    try {
      return await call()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }
}

/** The limiter that every read of a full change shares. */
export const limited: Limiter = createLimiter(SNAPSHOT_CONCURRENCY)
