import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DriveInfo,
  FileNode,
  ScanProgress,
  ScanResult,
  LockingProcess,
  DeleteMode
} from '../../shared/types'
import { Treemap } from './components/Treemap'
import { formatBytes, formatPercent, formatDate, colorForKey } from './format'
import { removePath, findPath } from './treeops'

const api = window.spaceInvader

interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
}

interface DeleteTarget {
  node: FileNode
  mode: DeleteMode
  locked?: boolean
  lockingProcesses?: LockingProcess[]
  working?: boolean
  error?: string
}

type RightTab = 'largest' | 'types' | 'selection'

function useElementSize(): [
  React.RefObject<HTMLDivElement | null>,
  { width: number; height: number }
] {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect
      setSize({ width: rect.width, height: rect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

export default function App(): React.JSX.Element {
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [rootPath, setRootPath] = useState('')
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [focusStack, setFocusStack] = useState<FileNode[]>([])
  const [selected, setSelected] = useState<FileNode | null>(null)
  const [rightTab, setRightTab] = useState<RightTab>('largest')
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [freedTotal, setFreedTotal] = useState(0)

  const [treemapRef, treemapSize] = useElementSize()

  const focusNode = focusStack[focusStack.length - 1] ?? result?.root ?? null

  const pushToast = useCallback(
    (kind: Toast['kind'], message: string) => {
      const id = Date.now() + Math.random()
      setToasts((t) => [...t, { id, kind, message }])
      setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id))
      }, 4200)
    },
    []
  )

  useEffect(() => {
    api.listDrives().then(setDrives).catch(() => undefined)
    api.getHomeDir().then((h) => setRootPath((p) => p || h))
  }, [])

  useEffect(() => {
    return api.onScanProgress(setProgress)
  }, [])

  const startScan = useCallback(
    async (path: string) => {
      if (!path) return
      setScanning(true)
      setProgress(null)
      setResult(null)
      setSelected(null)
      setFocusStack([])
      try {
        const res = await api.scan(path)
        setResult(res)
        setFocusStack([res.root])
        setRightTab('largest')
        pushToast(
          'success',
          `Scanned ${res.root.name} — ${formatBytes(res.root.size)} in ${(
            res.durationMs / 1000
          ).toFixed(1)}s`
        )
      } catch (err: any) {
        pushToast('error', `Scan failed: ${err?.message ?? err}`)
      } finally {
        setScanning(false)
        setProgress(null)
      }
    },
    [pushToast]
  )

  const cancelScan = useCallback(() => {
    api.cancelScan()
  }, [])

  const drillInto = useCallback((node: FileNode) => {
    if (!node.isDirectory) return
    setFocusStack((stack) => [...stack, node])
    setSelected(node)
  }, [])

  const navigateTo = useCallback((index: number) => {
    setFocusStack((stack) => stack.slice(0, index + 1))
  }, [])

  const browse = useCallback(async () => {
    const dir = await api.pickDirectory()
    if (dir) {
      setRootPath(dir)
      startScan(dir)
    }
  }, [startScan])

  const applyRemoval = useCallback(
    (path: string, freed: number) => {
      setResult((prev) => {
        if (!prev) return prev
        const res = removePath(prev.root, path)
        const newRoot = res ? res.node : prev.root
        const largestFiles = prev.largestFiles.filter(
          (f) => f.path !== path && !f.path.startsWith(path + '/')
        )
        const updated: ScanResult = {
          ...prev,
          root: newRoot,
          largestFiles
        }
        setFocusStack((stack) => {
          const rebuilt: FileNode[] = []
          let cursor: FileNode | null = newRoot
          for (const old of stack) {
            const match: FileNode | null = cursor
              ? findPath(cursor, old.path)
              : null
            if (!match) break
            rebuilt.push(match)
            cursor = match
          }
          return rebuilt.length ? rebuilt : [newRoot]
        })
        return updated
      })
      setSelected(null)
      setFreedTotal((f) => f + freed)
    },
    []
  )

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDeleteTarget({ ...deleteTarget, working: true, error: undefined })
    const res = await api.deletePath(deleteTarget.node.path, deleteTarget.mode)
    if (res.success) {
      applyRemoval(deleteTarget.node.path, res.freedBytes)
      pushToast(
        'success',
        `Deleted ${deleteTarget.node.name} — freed ${formatBytes(
          res.freedBytes
        )}`
      )
      setDeleteTarget(null)
      return
    }
    if (res.locked) {
      setDeleteTarget({
        ...deleteTarget,
        working: false,
        locked: true,
        lockingProcesses: res.lockingProcesses,
        error: res.error
      })
      return
    }
    setDeleteTarget({ ...deleteTarget, working: false, error: res.error })
    pushToast('error', `Delete failed: ${res.error}`)
  }, [deleteTarget, applyRemoval, pushToast])

  const unlockAndDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDeleteTarget({ ...deleteTarget, working: true, error: undefined })
    const unlock = await api.unlockPath(deleteTarget.node.path)
    if (!unlock.success) {
      setDeleteTarget({
        ...deleteTarget,
        working: false,
        error: unlock.error ?? 'Failed to unlock path.'
      })
      pushToast('error', unlock.error ?? 'Failed to unlock path.')
      return
    }
    pushToast(
      'info',
      `Unlocked — terminated ${unlock.killedPids.length} process(es)`
    )
    const res = await api.deletePath(deleteTarget.node.path, 'permanent')
    if (res.success) {
      applyRemoval(deleteTarget.node.path, res.freedBytes)
      pushToast(
        'success',
        `Deleted ${deleteTarget.node.name} after unlock — freed ${formatBytes(
          res.freedBytes
        )}`
      )
      setDeleteTarget(null)
    } else {
      setDeleteTarget({
        ...deleteTarget,
        working: false,
        error: res.error
      })
    }
  }, [deleteTarget, applyRemoval, pushToast])

  const totalSize = result?.root.size ?? 0
  const activeDrive = useMemo(
    () => drives.find((d) => rootPath.startsWith(d.mount)) ?? drives[0],
    [drives, rootPath]
  )

  return (
    <div className="app">
      <Starfield />
      <header className="topbar">
        <div className="brand">
          <span className="brand-glyph">{'\u{1F47E}'}</span>
          <div>
            <h1>SPACE INVADER</h1>
            <p>Disk space analyzer &amp; cleaner</p>
          </div>
        </div>
        <div className="scan-controls">
          <select
            className="drive-select"
            value={activeDrive?.mount ?? ''}
            onChange={(e) => setRootPath(e.target.value)}
          >
            {drives.map((d) => (
              <option key={d.mount} value={d.mount}>
                {d.label} — {formatBytes(d.freeBytes)} free
              </option>
            ))}
          </select>
          <input
            className="path-input"
            value={rootPath}
            spellCheck={false}
            onChange={(e) => setRootPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !scanning) startScan(rootPath)
            }}
            placeholder="/path/to/scan"
          />
          <button className="btn ghost" onClick={browse} disabled={scanning}>
            Browse
          </button>
          {scanning ? (
            <button className="btn danger" onClick={cancelScan}>
              Cancel
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={() => startScan(rootPath)}
              disabled={!rootPath}
            >
              Scan
            </button>
          )}
        </div>
      </header>

      <main className="layout">
        <section className="viz-panel">
          <Breadcrumb stack={focusStack} onNavigate={navigateTo} />
          <div className="treemap-host" ref={treemapRef}>
            {focusNode && focusNode.size > 0 ? (
              <Treemap
                root={focusNode}
                width={treemapSize.width}
                height={treemapSize.height}
                selectedPath={selected?.path ?? null}
                onSelect={setSelected}
                onDrill={drillInto}
              />
            ) : (
              <EmptyState scanning={scanning} progress={progress} />
            )}
          </div>
        </section>

        <aside className="side-panel">
          <div className="tabs">
            <button
              className={rightTab === 'largest' ? 'tab active' : 'tab'}
              onClick={() => setRightTab('largest')}
            >
              Largest files
            </button>
            <button
              className={rightTab === 'types' ? 'tab active' : 'tab'}
              onClick={() => setRightTab('types')}
            >
              File types
            </button>
            <button
              className={rightTab === 'selection' ? 'tab active' : 'tab'}
              onClick={() => setRightTab('selection')}
            >
              Selection
            </button>
          </div>

          <div className="tab-body">
            {rightTab === 'largest' && (
              <LargestFiles
                files={result?.largestFiles ?? []}
                onSelect={(n) => {
                  setSelected(n)
                  setRightTab('selection')
                }}
                onDelete={(n) =>
                  setDeleteTarget({ node: n, mode: 'trash' })
                }
              />
            )}
            {rightTab === 'types' && (
              <ExtensionBreakdown
                stats={result?.byExtension ?? []}
                total={totalSize}
              />
            )}
            {rightTab === 'selection' && (
              <SelectionPanel
                node={selected}
                total={totalSize}
                onReveal={(p) => api.revealInFolder(p)}
                onDelete={(n, mode) => setDeleteTarget({ node: n, mode })}
                onOpen={(n) => drillInto(n)}
              />
            )}
          </div>
        </aside>
      </main>

      <footer className="statusbar">
        <div className="status-left">
          {scanning ? (
            <span className="scanning-indicator">
              <span className="pulse" /> Scanning… {progress?.scanned ?? 0}{' '}
              items · {formatBytes(progress?.totalBytes ?? 0)}
              <span className="status-path">{progress?.currentPath}</span>
            </span>
          ) : result ? (
            <span>
              {result.aborted ? 'Scan cancelled · ' : 'Scan complete · '}
              {formatBytes(totalSize)} across this tree
            </span>
          ) : (
            <span>Pick a drive or folder and press Scan to begin.</span>
          )}
        </div>
        <div className="status-right">
          {freedTotal > 0 && (
            <span className="freed-badge">
              Reclaimed {formatBytes(freedTotal)}
            </span>
          )}
          {activeDrive && (
            <DriveGauge drive={activeDrive} />
          )}
        </div>
      </footer>

      {deleteTarget && (
        <DeleteModal
          target={deleteTarget}
          onChangeMode={(mode) =>
            setDeleteTarget({ ...deleteTarget, mode, locked: false })
          }
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
          onUnlock={unlockAndDelete}
        />
      )}

      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}

function Breadcrumb({
  stack,
  onNavigate
}: {
  stack: FileNode[]
  onNavigate: (index: number) => void
}): React.JSX.Element {
  return (
    <nav className="breadcrumb">
      {stack.length === 0 && <span className="crumb muted">No scan yet</span>}
      {stack.map((node, i) => (
        <span key={node.path} className="crumb-item">
          <button className="crumb" onClick={() => onNavigate(i)}>
            {i === 0 ? node.path : node.name}
          </button>
          {i < stack.length - 1 && <span className="crumb-sep">›</span>}
        </span>
      ))}
    </nav>
  )
}

function EmptyState({
  scanning,
  progress
}: {
  scanning: boolean
  progress: ScanProgress | null
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-invader">{'\u{1F47E}'}</div>
      {scanning ? (
        <>
          <h2>Scanning the galaxy of files…</h2>
          <p>{progress?.currentPath ?? 'Warming up sensors'}</p>
          <p className="muted">
            {progress?.scanned ?? 0} items · {formatBytes(progress?.totalBytes ?? 0)}
          </p>
        </>
      ) : (
        <>
          <h2>Ready to hunt down space hogs</h2>
          <p className="muted">
            Choose a folder and press Scan. The treemap shows where your bytes
            are hiding.
          </p>
        </>
      )}
    </div>
  )
}

function LargestFiles({
  files,
  onSelect,
  onDelete
}: {
  files: FileNode[]
  onSelect: (n: FileNode) => void
  onDelete: (n: FileNode) => void
}): React.JSX.Element {
  if (files.length === 0) {
    return <p className="panel-empty">No files scanned yet.</p>
  }
  const max = files[0]?.size ?? 1
  return (
    <ul className="file-list">
      {files.slice(0, 100).map((f) => (
        <li key={f.path} className="file-row" onClick={() => onSelect(f)}>
          <div className="file-bar-track">
            <div
              className="file-bar"
              style={{
                width: `${Math.max((f.size / max) * 100, 2)}%`,
                background: colorForKey(f.path)
              }}
            />
          </div>
          <div className="file-meta">
            <span className="file-name" title={f.path}>
              {f.name}
            </span>
            <span className="file-size">{formatBytes(f.size)}</span>
          </div>
          <button
            className="icon-btn"
            title="Move to Trash"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(f)
            }}
          >
            {'\u{1F5D1}'}
          </button>
        </li>
      ))}
    </ul>
  )
}

function ExtensionBreakdown({
  stats,
  total
}: {
  stats: { extension: string; size: number; count: number }[]
  total: number
}): React.JSX.Element {
  if (stats.length === 0) {
    return <p className="panel-empty">No data yet.</p>
  }
  return (
    <ul className="ext-list">
      {stats.slice(0, 40).map((s) => (
        <li key={s.extension} className="ext-row">
          <span
            className="ext-swatch"
            style={{ background: colorForKey(s.extension) }}
          />
          <span className="ext-name">{s.extension}</span>
          <span className="ext-count">{s.count} files</span>
          <span className="ext-size">{formatBytes(s.size)}</span>
          <span className="ext-pct">{formatPercent(s.size, total)}</span>
        </li>
      ))}
    </ul>
  )
}

function SelectionPanel({
  node,
  total,
  onReveal,
  onDelete,
  onOpen
}: {
  node: FileNode | null
  total: number
  onReveal: (p: string) => void
  onDelete: (n: FileNode, mode: DeleteMode) => void
  onOpen: (n: FileNode) => void
}): React.JSX.Element {
  if (!node) {
    return (
      <p className="panel-empty">
        Click a tile in the treemap to inspect it here.
      </p>
    )
  }
  return (
    <div className="selection">
      <div className="selection-head">
        <span className="selection-kind">
          {node.isDirectory ? '\u{1F4C1} Folder' : '\u{1F4C4} File'}
        </span>
        <h3 title={node.path}>{node.name}</h3>
      </div>
      <dl className="selection-stats">
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(node.size)}</dd>
        </div>
        <div>
          <dt>Share of tree</dt>
          <dd>{formatPercent(node.size, total)}</dd>
        </div>
        <div>
          <dt>Modified</dt>
          <dd>{formatDate(node.mtimeMs)}</dd>
        </div>
        {node.isDirectory && (
          <div>
            <dt>Items</dt>
            <dd>{node.children?.length ?? 0}</dd>
          </div>
        )}
      </dl>
      <code className="selection-path">{node.path}</code>
      <div className="selection-actions">
        {node.isDirectory && (
          <button className="btn ghost" onClick={() => onOpen(node)}>
            Open in treemap
          </button>
        )}
        <button className="btn ghost" onClick={() => onReveal(node.path)}>
          Reveal
        </button>
        <button
          className="btn warn"
          onClick={() => onDelete(node, 'trash')}
        >
          Move to Trash
        </button>
        <button
          className="btn danger"
          onClick={() => onDelete(node, 'permanent')}
        >
          Delete permanently
        </button>
      </div>
    </div>
  )
}

function DriveGauge({ drive }: { drive: DriveInfo }): React.JSX.Element {
  const usedPct = (drive.usedBytes / drive.totalBytes) * 100
  return (
    <div className="drive-gauge" title={`${drive.label} (${drive.mount})`}>
      <div className="gauge-track">
        <div
          className="gauge-fill"
          style={{ width: `${usedPct}%` }}
        />
      </div>
      <span className="gauge-text">
        {formatBytes(drive.freeBytes)} free of {formatBytes(drive.totalBytes)}
      </span>
    </div>
  )
}

function DeleteModal({
  target,
  onChangeMode,
  onCancel,
  onConfirm,
  onUnlock
}: {
  target: DeleteTarget
  onChangeMode: (mode: DeleteMode) => void
  onCancel: () => void
  onConfirm: () => void
  onUnlock: () => void
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{target.locked ? 'Path is locked' : 'Confirm deletion'}</h2>
        <p className="modal-target" title={target.node.path}>
          {target.node.name}
          <span className="modal-size">{formatBytes(target.node.size)}</span>
        </p>
        <code className="selection-path">{target.node.path}</code>

        {!target.locked && (
          <div className="mode-toggle">
            <label className={target.mode === 'trash' ? 'on' : ''}>
              <input
                type="radio"
                checked={target.mode === 'trash'}
                onChange={() => onChangeMode('trash')}
              />
              Move to Trash (recoverable)
            </label>
            <label className={target.mode === 'permanent' ? 'on' : ''}>
              <input
                type="radio"
                checked={target.mode === 'permanent'}
                onChange={() => onChangeMode('permanent')}
              />
              Delete permanently
            </label>
          </div>
        )}

        {target.locked && (
          <div className="lock-info">
            <p>{target.error}</p>
            <p className="muted">
              These processes are holding the path open:
            </p>
            <ul className="lock-list">
              {target.lockingProcesses?.map((p) => (
                <li key={p.pid}>
                  <strong>{p.command}</strong> · pid {p.pid} · {p.user}
                </li>
              ))}
            </ul>
            <p className="muted small">
              Unlocking terminates these processes so the path can be deleted.
            </p>
          </div>
        )}

        {target.error && !target.locked && (
          <p className="modal-error">{target.error}</p>
        )}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          {target.locked ? (
            <button
              className="btn danger"
              onClick={onUnlock}
              disabled={target.working}
            >
              {target.working ? 'Working…' : 'Unlock & Delete'}
            </button>
          ) : (
            <button
              className={target.mode === 'permanent' ? 'btn danger' : 'btn warn'}
              onClick={onConfirm}
              disabled={target.working}
            >
              {target.working
                ? 'Working…'
                : target.mode === 'permanent'
                  ? 'Delete permanently'
                  : 'Move to Trash'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Starfield(): React.JSX.Element {
  return <div className="starfield" aria-hidden="true" />
}
