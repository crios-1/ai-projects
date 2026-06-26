import { useMemo, useRef, useState } from 'react'
import {
  hierarchy,
  treemap,
  type HierarchyRectangularNode
} from 'd3-hierarchy'
import type { FileNode, SizeMetric } from '../../../shared/types'
import { formatBytes, colorForKey } from '../format'

interface TreemapProps {
  root: FileNode
  width: number
  height: number
  metric: SizeMetric
  selectedPath: string | null
  onSelect: (node: FileNode) => void
  onDrill: (node: FileNode) => void
  onContextMenu?: (node: FileNode, x: number, y: number) => void
}

const MAX_RENDER_DEPTH = 2

/**
 * Produces a shallow copy of the tree limited to `maxDepth`. Directories at the
 * depth boundary are collapsed into leaves that retain their aggregate size, so
 * the treemap stays readable on huge hierarchies.
 */
function trimTree(node: FileNode, depth: number, maxDepth: number): FileNode {
  if (!node.isDirectory || !node.children || depth >= maxDepth) {
    return { ...node, children: undefined }
  }
  return {
    ...node,
    children: node.children
      .filter((c) => c.size > 0)
      .map((c) => trimTree(c, depth + 1, maxDepth))
  }
}

export function Treemap({
  root,
  width,
  height,
  metric,
  selectedPath,
  onSelect,
  onDrill,
  onContextMenu
}: TreemapProps): React.JSX.Element {
  const [hover, setHover] = useState<{
    node: FileNode
    x: number
    y: number
  } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const nodes = useMemo(() => {
    const trimmed = trimTree(root, 0, MAX_RENDER_DEPTH)
    const h = hierarchy(trimmed, (d) => d.children)
      .sum((d) =>
        d.children && d.children.length ? 0 : Math.max(d[metric], 0)
      )
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

    const laidOut = treemap<FileNode>()
      .size([width, height])
      // A header strip on each top-level folder doubles as a drill handle.
      .paddingTop((d) => (d.depth === 1 && d.children?.length ? 20 : 0))
      .paddingInner(2)
      .round(true)(h)

    return laidOut.descendants().filter((d) => d.depth > 0)
  }, [root, width, height, metric])

  if (width <= 0 || height <= 0) return <div className="treemap-empty" />

  return (
    <div className="treemap-wrap" ref={containerRef}>
      <svg width={width} height={height} className="treemap-svg">
        <defs>
          <filter id="tile-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {nodes.map((d) => (
          <Tile
            key={d.data.path + d.depth}
            node={d}
            metric={metric}
            selected={d.data.path === selectedPath}
            onSelect={onSelect}
            onDrill={onDrill}
            onContextMenu={onContextMenu}
            onHover={(node, evt) => {
              const rect = containerRef.current?.getBoundingClientRect()
              setHover({
                node,
                x: evt.clientX - (rect?.left ?? 0),
                y: evt.clientY - (rect?.top ?? 0)
              })
            }}
            onLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {hover && (
        <div
          className="treemap-tooltip"
          style={{ left: hover.x + 14, top: hover.y + 14 }}
        >
          <strong>{hover.node.name}</strong>
          <span>{formatBytes(hover.node[metric])}</span>
          {hover.node.isDirectory && <em>Double-click to open</em>}
        </div>
      )}
    </div>
  )
}

interface TileProps {
  node: HierarchyRectangularNode<FileNode>
  metric: SizeMetric
  selected: boolean
  onSelect: (node: FileNode) => void
  onDrill: (node: FileNode) => void
  onContextMenu?: (node: FileNode, x: number, y: number) => void
  onHover: (node: FileNode, evt: React.MouseEvent) => void
  onLeave: () => void
}

function Tile({
  node,
  metric,
  selected,
  onSelect,
  onDrill,
  onContextMenu,
  onHover,
  onLeave
}: TileProps): React.JSX.Element | null {
  const w = node.x1 - node.x0
  const h = node.y1 - node.y0
  if (w < 1 || h < 1) return null

  // Color is keyed on the depth-1 ancestor so each top folder has one hue.
  const ancestor = node.ancestors().find((a) => a.depth === 1)
  const baseColor = colorForKey(ancestor?.data.path ?? node.data.path)
  const isGroup = node.depth === 1 && !!node.data.children?.length
  const showLabel = w > 54 && h > 20

  return (
    <g
      className={`tile depth-${node.depth} ${selected ? 'tile-selected' : ''}`}
      transform={`translate(${node.x0},${node.y0})`}
      onMouseMove={(e) => onHover(node.data, e)}
      onMouseLeave={onLeave}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(node.data)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        // Drill into a folder directly, or into a file's parent folder so the
        // whole nested area acts as a zoom-in handle.
        if (node.data.isDirectory) {
          onDrill(node.data)
        } else if (ancestor?.data.isDirectory) {
          onDrill(ancestor.data)
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu?.(node.data, e.clientX, e.clientY)
      }}
    >
      <rect
        width={w}
        height={h}
        rx={4}
        ry={4}
        fill={baseColor}
        fillOpacity={node.depth === 1 ? 0.28 : 0.85}
        stroke={selected ? '#ffffff' : baseColor}
        strokeWidth={selected ? 2 : 1}
        className="tile-rect"
      />
      {showLabel && (
        <text
          x={6}
          y={isGroup ? 15 : 16}
          className="tile-label"
          clipPath="inset(0)"
        >
          <tspan className="tile-name">
            {node.data.name}
            {isGroup ? `  ·  ${formatBytes(node.data[metric])}` : ''}
          </tspan>
          {!isGroup && h > 34 && (
            <tspan x={6} dy={14} className="tile-size">
              {formatBytes(node.data[metric])}
            </tspan>
          )}
        </text>
      )}
    </g>
  )
}
