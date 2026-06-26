import type { FileNode } from '../../shared/types'

/**
 * Returns a new tree with the node at `targetPath` removed and the sizes of all
 * ancestors reduced accordingly. Returns null if the node was not found.
 */
export function removePath(
  node: FileNode,
  targetPath: string
): { node: FileNode; removedSize: number; removedAlloc: number } | null {
  if (!node.children) return null

  const idx = node.children.findIndex((c) => c.path === targetPath)
  if (idx >= 0) {
    const removed = node.children[idx]
    const children = node.children.slice()
    children.splice(idx, 1)
    return {
      node: {
        ...node,
        children,
        size: node.size - removed.size,
        allocSize: node.allocSize - removed.allocSize
      },
      removedSize: removed.size,
      removedAlloc: removed.allocSize
    }
  }

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (!child.isDirectory || !targetPath.startsWith(child.path)) continue
    const result = removePath(child, targetPath)
    if (result) {
      const children = node.children.slice()
      children[i] = result.node
      return {
        node: {
          ...node,
          children,
          size: node.size - result.removedSize,
          allocSize: node.allocSize - result.removedAlloc
        },
        removedSize: result.removedSize,
        removedAlloc: result.removedAlloc
      }
    }
  }

  return null
}

/** Replaces the subtree at `targetPath` with `replacement`, fixing ancestor sizes. */
export function replaceSubtree(
  node: FileNode,
  targetPath: string,
  replacement: FileNode
): FileNode | null {
  if (node.path === targetPath) return replacement
  if (!node.children) return null
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (targetPath !== child.path && !targetPath.startsWith(child.path + '/'))
      continue
    const updatedChild = replaceSubtree(child, targetPath, replacement)
    if (updatedChild) {
      const children = node.children.slice()
      children[i] = updatedChild
      const sizeDelta = updatedChild.size - child.size
      const allocDelta = updatedChild.allocSize - child.allocSize
      return {
        ...node,
        children,
        size: node.size + sizeDelta,
        allocSize: node.allocSize + allocDelta
      }
    }
  }
  return null
}

/** Finds a node by absolute path within the tree. */
export function findPath(node: FileNode, targetPath: string): FileNode | null {
  if (node.path === targetPath) return node
  if (!node.children) return null
  for (const child of node.children) {
    if (targetPath === child.path || targetPath.startsWith(child.path + '/')) {
      const found = findPath(child, targetPath)
      if (found) return found
    }
  }
  return null
}

export interface SearchFilter {
  query: string
  minBytes: number
  extension: string
  /** Only match files older (by mtime) than this many days. 0 = no filter. */
  olderThanDays: number
}

/** Collects files (not directories) matching the filter, largest first. */
export function searchFiles(
  root: FileNode,
  filter: SearchFilter,
  limit = 300
): FileNode[] {
  const q = filter.query.trim().toLowerCase()
  const ext = filter.extension.trim().toLowerCase()
  const cutoff =
    filter.olderThanDays > 0
      ? Date.now() - filter.olderThanDays * 86400000
      : Infinity
  const out: FileNode[] = []

  const walk = (node: FileNode): void => {
    if (node.isDirectory) {
      for (const c of node.children ?? []) walk(c)
      return
    }
    if (node.size < filter.minBytes) return
    if (q && !node.name.toLowerCase().includes(q)) return
    if (ext && !node.name.toLowerCase().endsWith(ext)) return
    if (filter.olderThanDays > 0 && node.mtimeMs > cutoff) return
    out.push(node)
  }
  walk(root)
  out.sort((a, b) => b.size - a.size)
  return out.slice(0, limit)
}

export interface JunkItem {
  node: FileNode
  category: string
  rule: string
}

interface DirRule {
  category: string
  label: string
  names: string[]
}

interface FileRule {
  category: string
  label: string
  test: (name: string) => boolean
}

const DIR_RULES: DirRule[] = [
  {
    category: 'Dependency caches',
    label: 'node_modules',
    names: ['node_modules']
  },
  {
    category: 'Build artifacts',
    label: 'build output',
    names: ['dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo']
  },
  {
    category: 'Tooling caches',
    label: 'cache directory',
    names: [
      '.cache',
      'cache',
      'caches',
      '__pycache__',
      '.pytest_cache',
      '.mypy_cache',
      '.gradle',
      '.parcel-cache',
      '.eslintcache'
    ]
  }
]

const FILE_RULES: FileRule[] = [
  {
    category: 'Logs & temp files',
    label: 'log file',
    test: (n) => n.endsWith('.log')
  },
  {
    category: 'Logs & temp files',
    label: 'temp file',
    test: (n) =>
      n.endsWith('.tmp') ||
      n.endsWith('.temp') ||
      n.endsWith('.part') ||
      n.endsWith('.crdownload')
  },
  {
    category: 'OS clutter',
    label: 'OS metadata',
    test: (n) => n === '.ds_store' || n === 'thumbs.db' || n === 'desktop.ini'
  }
]

/**
 * Identifies likely-disposable items (dependency/build/tooling caches, logs,
 * temp files, OS clutter). When a whole directory matches, it is reported as a
 * single item and its contents are not descended into.
 */
export function findJunk(root: FileNode): JunkItem[] {
  const out: JunkItem[] = []

  const walk = (node: FileNode): void => {
    if (node.isDirectory) {
      const name = node.name.toLowerCase()
      const dirRule = DIR_RULES.find((r) => r.names.includes(name))
      if (dirRule) {
        out.push({ node, category: dirRule.category, rule: dirRule.label })
        return
      }
      for (const c of node.children ?? []) walk(c)
      return
    }
    const fname = node.name.toLowerCase()
    const fileRule = FILE_RULES.find((r) => r.test(fname))
    if (fileRule) {
      out.push({ node, category: fileRule.category, rule: fileRule.label })
    }
  }

  for (const c of root.children ?? []) walk(c)
  // root itself could match (e.g. scanning a node_modules dir directly)
  if (out.length === 0 && root.isDirectory) {
    const name = root.name.toLowerCase()
    const dirRule = DIR_RULES.find((r) => r.names.includes(name))
    if (dirRule) out.push({ node: root, category: dirRule.category, rule: dirRule.label })
  }
  out.sort((a, b) => b.node.size - a.node.size)
  return out
}
