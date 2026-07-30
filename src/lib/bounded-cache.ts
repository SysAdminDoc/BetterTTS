export function readLruEntry<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key)
  if (value === undefined) return undefined
  cache.delete(key)
  cache.set(key, value)
  return value
}

export function writeLruEntry<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
  dispose: (value: V) => void = () => {},
): void {
  const previous = cache.get(key)
  if (previous !== undefined && previous !== value) dispose(previous)
  cache.delete(key)
  cache.set(key, value)

  const limit = Math.max(1, Math.floor(maxEntries))
  while (cache.size > limit) {
    const oldest = cache.entries().next().value as [K, V] | undefined
    if (!oldest) break
    cache.delete(oldest[0])
    dispose(oldest[1])
  }
}
