import { promises as fs } from 'fs'
import { join, extname } from 'path'
import type {
  FileNode,
  ScanResult,
  ScanProgress,
  ScanOptions,
  ExtensionStat
} from '../shared/types'

const LARGEST_FILES_LIMIT = 500
const PROGRESS_THROTTLE_MS = 120

/**
 * Recursively scans a directory tree, computing aggregate sizes (both apparent
 * and on-disk), the largest individual files, and a per-extension breakdown.
 * Designed to be resilient: unreadable entries (permissions, broken symlinks,
 * races) are skipped rather than aborting the whole scan.
 */
export class DiskScanner {
  private aborted = false
  private scanned = 0
  private totalBytes = 0
  private lastProgressAt = 0
  private rootDev = -1
  private readonly largest: FileNode[] = []
  private readonly extensions = new Map<string, ExtensionStat>()

  constructor(
    private readonly onProgress: (p: ScanProgress) => void,
    private readonly options: ScanOptions = {}
  ) {}

  abort(): void {
    this.aborted = true
  }

  async scan(rootPath: string): Promise<ScanResult> {
    const start = Date.now()
    try {
      this.rootDev = (await fs.lstat(rootPath)).dev
    } catch {
      this.rootDev = -1
    }
    const root = await this.walk(rootPath)
    this.emitProgress(rootPath)

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
      return this.makeNode(currentPath, 0, 0, false, 0, 0)
    }

    this.scanned += 1
    const alloc = stat.blocks * 512

    // Never follow symlinks: avoids cycles and double-counting.
    if (stat.isSymbolicLink()) {
      return this.makeNode(
        currentPath,
        stat.size,
        alloc,
        false,
        stat.mtimeMs,
        stat.atimeMs
      )
    }

    if (!stat.isDirectory()) {
      const node = this.makeNode(
        currentPath,
        stat.size,
        alloc,
        false,
        stat.mtimeMs,
        stat.atimeMs
      )
      this.totalBytes += stat.size
      this.recordExtension(currentPath, stat.size)
      this.considerLargest(node)
      this.maybeEmitProgress(currentPath)
      return node
    }

    // Do not descend into other filesystems unless explicitly requested.
    if (
      !this.options.crossFilesystems &&
      this.rootDev >= 0 &&
      stat.dev !== this.rootDev
    ) {
      return this.makeNode(
        currentPath,
        0,
        alloc,
        true,
        stat.mtimeMs,
        stat.atimeMs
      )
    }

    const node = this.makeNode(
      currentPath,
      0,
      alloc,
      true,
      stat.mtimeMs,
      stat.atimeMs
    )
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
      node.allocSize += child.allocSize
    }

    return node
  }

  private makeNode(
    path: string,
    size: number,
    allocSize: number,
    isDirectory: boolean,
    mtimeMs: number,
    atimeMs: number
  ): FileNode {
    return {
      path,
      name: basename(path),
      size,
      allocSize,
      isDirectory,
      mtimeMs,
      atimeMs
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
      this.emitProgress(currentPath)
    }
  }

  private emitProgress(currentPath: string): void {
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
