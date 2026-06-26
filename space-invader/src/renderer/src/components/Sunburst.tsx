import { useMemo, useRef, useState } from 'react'
import {
  hierarchy,
  partition,
  type HierarchyRectangularNode
} from 'd3-hierarchy'
import { arc as d3arc } from 'd3-shape'
import type { FileNode, SizeMetric } from '../../../shared/types'
import { formatBytes, colorForKey } from '../format'

interface SunburstProps {
  root: FileNode
  width: number
  height: number
  metric: SizeMetric
  selectedPath: string | null
  onSelect: (node: FileNode) => void
  onDrill: (node: FileNode) => void
  onContextMenu?: (node: FileNode, x: number, y: number) => void
}

const MAX_RENDER_DEPTH = 3

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

export function Sunburst({
  root,
  width,
  height,
  metric,
  selectedPath,
  onSelect,
  onDrill,
  onContextMenu
}: SunburstProps): React.JSX.Element {
  const [hover, setHover] = useState<{
    node: FileNode
    x: number
    y: number
  } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const radius = Math.max(0, Math.min(width, height) / 2 - 6)

  const nodes = useMemo(() => {
    if (radius <= 0) return []
    const trimmed = trimTree(root, 0, MAX_RENDER_DEPTH)
    const h = hierarchy(trimmed, (d) => d.children)
      .sum((d) =>
        d.children && d.children.length ? 0 : Math.max(d[metric], 0)
      )
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

    partition<FileNode>().size([2 * Math.PI, radius])(h)
    return (h as HierarchyRectangularNode<FileNode>)
      .descendants()
      .filter((d) => d.depth > 0)
  }, [root, radius, metric])

  const arcGen = useMemo(
    () =>
      d3arc<HierarchyRectangularNode<FileNode>>()
        .startAngle((d) => d.x0)
        .endAngle((d) => d.x1)
        .padAngle(0.004)
        .innerRadius((d) => d.y0)
        .outerRadius((d) => d.y1 - 1),
    []
  )

  if (width <= 0 || height <= 0) return <div className="treemap-empty" />

  const cx = width / 2
  const cy = height / 2

  return (
    <div className="treemap-wrap" ref={containerRef}>
      <svg width={width} height={height} className="treemap-svg">
        <g transform={`translate(${cx},${cy})`}>
          {nodes.map((d) => {
            const ancestor = d.ancestors().find((a) => a.depth === 1)
            const color = colorForKey(ancestor?.data.path ?? d.data.path)
            const selected = d.data.path === selectedPath
            const path = arcGen(d) ?? undefined
            return (
              <path
                key={d.data.path + d.depth}
                d={path}
                fill={color}
                fillOpacity={Math.max(0.92 - d.depth * 0.16, 0.4)}
                stroke={selected ? '#fff' : '#0a0a16'}
                strokeWidth={selected ? 2 : 0.5}
                className="sun-arc"
                onMouseMove={(e) => {
                  const rect = containerRef.current?.getBoundingClientRect()
                  setHover({
                    node: d.data,
                    x: e.clientX - (rect?.left ?? 0),
                    y: e.clientY - (rect?.top ?? 0)
                  })
                }}
                onMouseLeave={() => setHover(null)}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(d.data)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (d.data.isDirectory) onDrill(d.data)
                  else if (ancestor?.data.isDirectory) onDrill(ancestor.data)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onContextMenu?.(d.data, e.clientX, e.clientY)
                }}
              />
            )
          })}
          <circle r={Math.max(radius * 0.12, 0)} className="sun-hub" />
          <text className="sun-hub-label" textAnchor="middle" dy="0.35em">
            {formatBytes(root[metric])}
          </text>
        </g>
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
