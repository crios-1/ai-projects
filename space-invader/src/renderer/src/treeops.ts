import type { FileNode } from '../../shared/types'

/**
 * Returns a new tree with the node at `targetPath` removed and the sizes of all
 * ancestors reduced accordingly. Returns null if the node was not found.
 */
export function removePath(
  node: FileNode,
  targetPath: string
): { node: FileNode; removedSize: number } | null {
  if (!node.children) return null

  const idx = node.children.findIndex((c) => c.path === targetPath)
  if (idx >= 0) {
    const removed = node.children[idx]
    const children = node.children.slice()
    children.splice(idx, 1)
    return {
      node: { ...node, children, size: node.size - removed.size },
      removedSize: removed.size
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
        node: { ...node, children, size: node.size - result.removedSize },
        removedSize: result.removedSize
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
