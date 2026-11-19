// One lock for the work that must not overlap: a build and an add-issues action (file 00 section 3.7.4).
let chain: Promise<unknown> = Promise.resolve()

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
