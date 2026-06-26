import { promises as fs, createReadStream } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import type {
  DuplicateGroup,
  DuplicateResult,
  DuplicateProgress
} from '../shared/types'

const QUICK_HASH_BYTES = 65536
const PROGRESS_THROTTLE_MS = 120

/**
 * Finds duplicate files within a directory tree. Strategy:
 *  1. Group candidate files by exact byte size (cheap).
 *  2. Within each size group, prune using a quick hash of the first 64 KB.
 *  3. Fully hash the survivors (SHA-256) and group by content hash.
 * Only groups with two or more identical files are reported.
 */
export class DuplicateFinder {
  private aborted = false
  private lastProgressAt = 0
  private filesHashed = 0

  constructor(
    private readonly onProgress: (p: DuplicateProgress) => void
  ) {}

  abort(): void {
    this.aborted = true
  }

  async find(rootPath: string, minSize: number): Promise<DuplicateResult> {
    const start = Date.now()
    const bySize = new Map<number, string[]>()
    await this.collectBySize(rootPath, Math.max(minSize, 1), bySize)

    const candidates: { path: string; size: number }[] = []
    for (const [size, paths] of bySize) {
      if (paths.length > 1) {
        for (const p of paths) candidates.push({ path: p, size })
      }
    }

    const groups: DuplicateGroup[] = []
    let reclaimableBytes = 0

    // Bucket by (size + quick hash) to avoid fully hashing unique files.
    const quickBuckets = new Map<string, { path: string; size: number }[]>()
    for (let i = 0; i < candidates.length; i++) {
      if (this.aborted) break
      const c = candidates[i]
      const quick = await this.quickHash(c.path)
      if (quick === null) continue
      const key = `${c.size}:${quick}`
      const list = quickBuckets.get(key)
      if (list) list.push(c)
      else quickBuckets.set(key, [c])
      this.emitProgress('hashing', i + 1, candidates.length, c.path)
    }

    for (const bucket of quickBuckets.values()) {
      if (this.aborted) break
      if (bucket.length < 2) continue
      const byFull = new Map<string, { path: string; size: number }[]>()
      for (const c of bucket) {
        if (this.aborted) break
        const full = await this.fullHash(c.path)
        if (full === null) continue
        this.filesHashed += 1
        const list = byFull.get(full)
        if (list) list.push(c)
        else byFull.set(full, [c])
      }
      for (const [hash, list] of byFull) {
        if (list.length < 2) continue
        const size = list[0].size
        const wasted = size * (list.length - 1)
        reclaimableBytes += wasted
        groups.push({
          hash,
          size,
          paths: list.map((x) => x.path),
          wastedBytes: wasted
        })
      }
    }

    groups.sort((a, b) => b.wastedBytes - a.wastedBytes)

    return {
      groups,
      reclaimableBytes,
      filesHashed: this.filesHashed,
      durationMs: Date.now() - start,
      aborted: this.aborted
    }
  }

  private async collectBySize(
    currentPath: string,
    minSize: number,
    bySize: Map<number, string[]>,
    scannedRef: { n: number } = { n: 0 }
  ): Promise<void> {
    if (this.aborted) return
    let stat: import('fs').Stats
    try {
      stat = await fs.lstat(currentPath)
    } catch {
      return
    }
    if (stat.isSymbolicLink()) return

    if (stat.isDirectory()) {
      let entries: import('fs').Dirent[] = []
      try {
        entries = await fs.readdir(currentPath, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (this.aborted) break
        await this.collectBySize(
          join(currentPath, entry.name),
          minSize,
          bySize,
          scannedRef
        )
      }
      return
    }

    scannedRef.n += 1
    if (stat.size >= minSize) {
      const list = bySize.get(stat.size)
      if (list) list.push(currentPath)
      else bySize.set(stat.size, [currentPath])
    }
    this.emitProgress('sizing', scannedRef.n, scannedRef.n, currentPath)
  }

  private async quickHash(path: string): Promise<string | null> {
    let fh: import('fs/promises').FileHandle | null = null
    try {
      fh = await fs.open(path, 'r')
      const buf = Buffer.alloc(QUICK_HASH_BYTES)
      const { bytesRead } = await fh.read(buf, 0, QUICK_HASH_BYTES, 0)
      return createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex')
    } catch {
      return null
    } finally {
      await fh?.close().catch(() => undefined)
    }
  }

  private fullHash(path: string): Promise<string | null> {
    return new Promise((resolve) => {
      const hash = createHash('sha256')
      const stream = createReadStream(path)
      stream.on('error', () => resolve(null))
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  private emitProgress(
    phase: DuplicateProgress['phase'],
    processed: number,
    total: number,
    currentPath: string
  ): void {
    const now = Date.now()
    if (now - this.lastProgressAt >= PROGRESS_THROTTLE_MS) {
      this.lastProgressAt = now
      this.onProgress({ phase, processed, total, currentPath })
    }
  }
}
