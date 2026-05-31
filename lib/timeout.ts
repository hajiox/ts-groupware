export async function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  fallback: unknown,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<unknown>(resolve => {
        timer = setTimeout(() => {
          console.error(`[Timeout] ${label}`)
          resolve(fallback)
        }, ms)
      }),
    ]) as T
  } finally {
    if (timer) clearTimeout(timer)
  }
}
