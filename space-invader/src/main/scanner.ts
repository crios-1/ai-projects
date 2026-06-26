import { promises as fs } from 'fs'
import { join, extname } from 'path'
import type {
  FileNode,
  ScanResult,
  ScanProgress,
  ExtensionStat
} from '../shared/types'

const LARGEST_FILES_LIMIT = 500
const PROGRESS_THROTTLE_MS = 120

/**
 * Recursively scans a directory tree, computing aggregate sizes, the largest
 * individual files, and a per-extension breakdown. Designed to be resilient:
 * unreadable entries (permissions, broken symlinks, races) are skipped rather
 * than aborting the whole scan.
 */
export class DiskScanner {
  private aborted = false
  private scanned = 0
  private totalBytes = 0
  private lastProgressAt = 0
  private readonly largest: FileNode[] = []
  private readonly extensions = new Map<string, ExtensionStat>()

  constructor(private readonly onProgress: (p: ScanProgress) => void) {}

  abort(): void {
    this.aborted = true
  }

  async scan(rootPath: string): Promise<ScanResult> {
    const start = Date.now()
    const root = await this.walk(rootPath)
    this.emitProgress(rootPath, true)

    const byExtension = [...this.extensions.values()].sort(
      (a, b) => b.size - a.size
    )
    const largestFiles = [...this.largest].sort((a, b) => b.size - a.size)

    return {
      root,
      largestFiles,
      byExtension,
      durationMs: Date.now() - start,
      aborted: this.aborted
    }
  }

  private async walk(currentPath: string): Promise<FileNode> {
    let stat: import('fs').Stats
    try {
      stat = await fs.lstat(currentPath)
    } catch {
      return this.makeNode(currentPath, 0, false, 0)
    }

    this.scanned += 1

    // Never follow symlinks: avoids cycles and double-counting.
    if (stat.isSymbolicLink()) {
      return this.makeNode(currentPath, stat.size, false, stat.mtimeMs)
    }

    if (!stat.isDirectory()) {
      const node = this.makeNode(
        currentPath,
        stat.size,
        false,
        stat.mtimeMs
      )
      this.totalBytes += stat.size
      this.recordExtension(currentPath, stat.size)
      this.considerLargest(node)
      this.maybeEmitProgress(currentPath)
      return node
    }

    const node = this.makeNode(currentPath, 0, true, stat.mtimeMs)
    node.children = []
    this.maybeEmitProgress(currentPath)

    let entries: import('fs').Dirent[] = []
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true })
    } catch {
      return node
    }

    for (const entry of entries) {
      if (this.aborted) break
      const childPath = join(currentPath, entry.name)
      const child = await this.walk(childPath)
      node.children.push(child)
      node.size += child.size
    }

    return node
  }

  private makeNode(
    path: string,
    size: number,
    isDirectory: boolean,
    mtimeMs: number
  ): FileNode {
    return {
      path,
      name: basename(path),
      size,
      isDirectory,
      mtimeMs
    }
  }

  private recordExtension(path: string, size: number): void {
    const ext = (extname(path) || '(no extension)').toLowerCase()
    const existing = this.extensions.get(ext)
    if (existing) {
      existing.size += size
      existing.count += 1
    } else {
      this.extensions.set(ext, { extension: ext, size, count: 1 })
    }
  }

  private considerLargest(node: FileNode): void {
    if (this.largest.length < LARGEST_FILES_LIMIT) {
      this.largest.push(node)
      return
    }
    // Replace the current smallest if this file is bigger.
    let minIdx = 0
    for (let i = 1; i < this.largest.length; i++) {
      if (this.largest[i].size < this.largest[minIdx].size) minIdx = i
    }
    if (node.size > this.largest[minIdx].size) {
      this.largest[minIdx] = node
    }
  }

  private maybeEmitProgress(currentPath: string): void {
    const now = Date.now()
    if (now - this.lastProgressAt >= PROGRESS_THROTTLE_MS) {
      this.lastProgressAt = now
      this.emitProgress(currentPath, false)
    }
  }

  private emitProgress(currentPath: string, _final: boolean): void {
    this.onProgress({
      currentPath,
      scanned: this.scanned,
      totalBytes: this.totalBytes
    })
  }
}

function basename(p: string): string {
  const normalized = p.replace(/[/\\]+$/, '')
  const idx = Math.max(
    normalized.lastIndexOf('/'),
    normalized.lastIndexOf('\\')
  )
  return idx >= 0 ? normalized.slice(idx + 1) || normalized : normalized
}
