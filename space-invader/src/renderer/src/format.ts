export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  const value = bytes / Math.pow(1024, exp)
  const digits = value >= 100 || exp === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[exp]}`
}

export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  return `${((part / whole) * 100).toFixed(1)}%`
}

export function formatDate(mtimeMs: number): string {
  if (!mtimeMs) return '—'
  return new Date(mtimeMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/**
 * Deterministic vivid color derived from a string, used to give each treemap
 * tile / extension a stable neon hue.
 */
export function colorForKey(key: string): string {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 78%, 58%)`
}
