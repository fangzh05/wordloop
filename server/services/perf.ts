export async function perf<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const enabled = typeof process !== "undefined" && process.env.WORDLOOP_PERF_LOG === "1";
  const startedAt = enabled ? Date.now() : 0;
  try {
    return await operation();
  } finally {
    if (enabled) console.log(`[wordloop perf] ${name} ${Date.now() - startedAt}ms`);
  }
}
