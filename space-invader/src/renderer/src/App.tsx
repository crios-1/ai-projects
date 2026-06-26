import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DriveInfo,
  FileNode,
  ScanProgress,
  ScanResult,
  LockingProcess,
  DeleteMode,
  SizeMetric,
  DuplicateResult,
  DuplicateProgress,
  DuplicateGroup,
  TrashInfo
} from '../../shared/types'
import { Treemap } from './components/Treemap'
import { Sunburst } from './components/Sunburst'
import { ContextMenu, type MenuItem } from './components/ContextMenu'
import { formatBytes, formatPercent, formatDate, colorForKey } from './format'
import {
  removePath,
  findPath,
  replaceSubtree,
  searchFiles,
  findJunk,
  type SearchFilter,
  type JunkItem
} from './treeops'

const api = window.spaceInvader

interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
}

interface CartItem {
  path: string
  name: string
  size: number
  isDirectory: boolean
}

interface DeleteTarget {
  node: CartItem
  mode: DeleteMode
  locked?: boolean
  lockingProcesses?: LockingProcess[]
  working?: boolean
  error?: string
}

type RightTab =
  | 'largest'
  | 'types'
  | 'duplicates'
  | 'cleanup'
  | 'find'
  | 'selection'

type ViewMode = 'treemap' | 'sunburst'

const SETTINGS_KEY = 'space-invader.settings'

interface Settings {
  metric: SizeMetric
  view: ViewMode
  crossFilesystems: boolean
  lastPath: string
}

function loadSettings(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

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

function toCartItem(n: FileNode): CartItem {
  return { path: n.path, name: n.name, size: n.size, isDirectory: n.isDirectory }
}

export default function App(): React.JSX.Element {
  const saved = useMemo(loadSettings, [])
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [rootPath, setRootPath] = useState(saved.lastPath ?? '')
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [scanStartedAt, setScanStartedAt] = useState(0)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [focusStack, setFocusStack] = useState<FileNode[]>([])
  const [selected, setSelected] = useState<FileNode | null>(null)
  const [rightTab, setRightTab] = useState<RightTab>('largest')
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [freedTotal, setFreedTotal] = useState(0)

  const [metric, setMetric] = useState<SizeMetric>(saved.metric ?? 'size')
  const [view, setView] = useState<ViewMode>(saved.view ?? 'treemap')
  const [crossFs, setCrossFs] = useState<boolean>(saved.crossFilesystems ?? false)

  const [cart, setCart] = useState<Map<string, CartItem>>(new Map())
  const [cartOpen, setCartOpen] = useState(false)
  const [cartMode, setCartMode] = useState<DeleteMode>('trash')
  const [cartBusy, setCartBusy] = useState(false)

  const [dupResult, setDupResult] = useState<DuplicateResult | null>(null)
  const [dupRunning, setDupRunning] = useState(false)
  const [dupProgress, setDupProgress] = useState<DuplicateProgress | null>(null)

  const [trashInfo, setTrashInfo] = useState<TrashInfo | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    node: CartItem
  } | null>(null)

  const [filter, setFilter] = useState<SearchFilter>({
    query: '',
    minBytes: 0,
    extension: '',
    olderThanDays: 0
  })

  const [treemapRef, treemapSize] = useElementSize()

  const focusNode = focusStack[focusStack.length - 1] ?? result?.root ?? null
  const totalSize = result ? result.root[metric] : 0

  const pushToast = useCallback((kind: Toast['kind'], message: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, kind, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4600)
  }, [])

  const refreshTrash = useCallback(() => {
    api.getTrashInfo().then(setTrashInfo).catch(() => undefined)
  }, [])

  useEffect(() => {
    api.listDrives().then(setDrives).catch(() => undefined)
    api.getHomeDir().then((h) => setRootPath((p) => p || h))
    refreshTrash()
  }, [refreshTrash])

  useEffect(() => api.onScanProgress(setProgress), [])
  useEffect(() => api.onDuplicateProgress(setDupProgress), [])

  useEffect(() => {
    const settings: Settings = { metric, view, crossFilesystems: crossFs, lastPath: rootPath }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [metric, view, crossFs, rootPath])

  const startScan = useCallback(
    async (path: string) => {
      if (!path) return
      setScanning(true)
      setProgress(null)
      setResult(null)
      setSelected(null)
      setFocusStack([])
      setDupResult(null)
      setScanStartedAt(Date.now())
      try {
        const res = await api.scan(path, { crossFilesystems: crossFs })
        setResult(res)
        setFocusStack([res.root])
        setRightTab('largest')
        pushToast(
          'success',
          `Scanned ${res.root.name} — ${formatBytes(res.root[metric])} in ${(
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
    [pushToast, crossFs, metric]
  )

  const rescanFocus = useCallback(async () => {
    if (!focusNode || !result) return
    const target = focusNode.path
    pushToast('info', `Rescanning ${focusNode.name}…`)
    try {
      const res = await api.scan(target, { crossFilesystems: crossFs })
      setResult((prev) => {
        if (!prev) return prev
        if (prev.root.path === target) {
          setFocusStack([res.root])
          return res
        }
        const newRoot = replaceSubtree(prev.root, target, res.root)
        if (!newRoot) return prev
        setFocusStack((stack) => {
          const rebuilt: FileNode[] = []
          let cursor: FileNode | null = newRoot
          for (const old of stack) {
            const match: FileNode | null = cursor ? findPath(cursor, old.path) : null
            if (!match) break
            rebuilt.push(match)
            cursor = match
          }
          return rebuilt.length ? rebuilt : [newRoot]
        })
        return { ...prev, root: newRoot }
      })
      pushToast('success', `Rescanned ${res.root.name}`)
    } catch (err: any) {
      pushToast('error', `Rescan failed: ${err?.message ?? err}`)
    }
  }, [focusNode, result, crossFs, pushToast])

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

  const addToCart = useCallback((item: CartItem) => {
    setCart((c) => {
      const next = new Map(c)
      next.set(item.path, item)
      return next
    })
  }, [])

  const removeFromCart = useCallback((path: string) => {
    setCart((c) => {
      const next = new Map(c)
      next.delete(path)
      return next
    })
  }, [])

  const applyRemoval = useCallback((path: string, freed: number) => {
    setResult((prev) => {
      if (!prev) return prev
      const res = removePath(prev.root, path)
      const newRoot = res ? res.node : prev.root
      const largestFiles = prev.largestFiles.filter(
        (f) => f.path !== path && !f.path.startsWith(path + '/')
      )
      setFocusStack((stack) => {
        const rebuilt: FileNode[] = []
        let cursor: FileNode | null = newRoot
        for (const old of stack) {
          const match: FileNode | null = cursor ? findPath(cursor, old.path) : null
          if (!match) break
          rebuilt.push(match)
          cursor = match
        }
        return rebuilt.length ? rebuilt : [newRoot]
      })
      return { ...prev, root: newRoot, largestFiles }
    })
    setDupResult((prev) =>
      prev
        ? {
            ...prev,
            groups: prev.groups
              .map((g) => ({
                ...g,
                paths: g.paths.filter((p) => p !== path)
              }))
              .filter((g) => g.paths.length > 1)
          }
        : prev
    )
    removeFromCart(path)
    setSelected((s) => (s && s.path === path ? null : s))
    setFreedTotal((f) => f + freed)
  }, [removeFromCart])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDeleteTarget({ ...deleteTarget, working: true, error: undefined })
    const res = await api.deletePath(deleteTarget.node.path, deleteTarget.mode)
    if (res.success) {
      applyRemoval(deleteTarget.node.path, res.freedBytes)
      pushToast('success', `Deleted ${deleteTarget.node.name} — freed ${formatBytes(res.freedBytes)}`)
      setDeleteTarget(null)
      if (deleteTarget.mode === 'trash') refreshTrash()
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
  }, [deleteTarget, applyRemoval, pushToast, refreshTrash])

  const unlockAndDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDeleteTarget({ ...deleteTarget, working: true, error: undefined })
    const unlock = await api.unlockPath(deleteTarget.node.path)
    if (!unlock.success) {
      setDeleteTarget({ ...deleteTarget, working: false, error: unlock.error })
      pushToast('error', unlock.error ?? 'Failed to unlock path.')
      return
    }
    pushToast('info', `Unlocked — terminated ${unlock.killedPids.length} process(es)`)
    const res = await api.deletePath(deleteTarget.node.path, 'permanent')
    if (res.success) {
      applyRemoval(deleteTarget.node.path, res.freedBytes)
      pushToast('success', `Deleted ${deleteTarget.node.name} after unlock — freed ${formatBytes(res.freedBytes)}`)
      setDeleteTarget(null)
    } else {
      setDeleteTarget({ ...deleteTarget, working: false, error: res.error })
    }
  }, [deleteTarget, applyRemoval, pushToast])

  const runBatchDelete = useCallback(async () => {
    const items = [...cart.values()]
    if (items.length === 0) return
    setCartBusy(true)
    let freed = 0
    let deleted = 0
    let failed = 0
    let unlocked = 0
    for (const item of items) {
      let res = await api.deletePath(item.path, cartMode)
      if (!res.success && res.locked) {
        const unlock = await api.unlockPath(item.path)
        if (unlock.success) {
          unlocked += 1
          res = await api.deletePath(item.path, 'permanent')
        }
      }
      if (res.success) {
        applyRemoval(item.path, res.freedBytes)
        freed += res.freedBytes
        deleted += 1
      } else {
        failed += 1
      }
    }
    setCartBusy(false)
    setCartOpen(false)
    if (cartMode === 'trash') refreshTrash()
    const unlockNote = unlocked > 0 ? ` (unlocked ${unlocked})` : ''
    if (failed === 0) {
      pushToast('success', `Deleted ${deleted} item(s) — freed ${formatBytes(freed)}${unlockNote}`)
    } else {
      pushToast('error', `Deleted ${deleted}, failed ${failed} — freed ${formatBytes(freed)}${unlockNote}`)
    }
  }, [cart, cartMode, applyRemoval, pushToast, refreshTrash])

  const findDuplicates = useCallback(async () => {
    if (!focusNode) return
    setDupRunning(true)
    setDupProgress(null)
    setDupResult(null)
    try {
      const res = await api.findDuplicates(focusNode.path, 4096)
      setDupResult(res)
      pushToast(
        res.groups.length > 0 ? 'success' : 'info',
        res.groups.length > 0
          ? `Found ${res.groups.length} duplicate group(s) — ${formatBytes(res.reclaimableBytes)} reclaimable`
          : 'No duplicates found'
      )
    } catch (err: any) {
      pushToast('error', `Duplicate scan failed: ${err?.message ?? err}`)
    } finally {
      setDupRunning(false)
      setDupProgress(null)
    }
  }, [focusNode, pushToast])

  const emptyTrash = useCallback(async () => {
    const res = await api.emptyTrash()
    if (res.success) {
      pushToast('success', `Emptied trash — freed ${formatBytes(res.freedBytes)}`)
      setFreedTotal((f) => f + res.freedBytes)
    } else {
      pushToast('error', res.error ?? 'Failed to empty trash')
    }
    refreshTrash()
  }, [pushToast, refreshTrash])

  const exportReport = useCallback(
    async (format: 'json' | 'csv') => {
      if (!result) return
      const res = await api.saveReport(
        {
          rootPath: result.root.path,
          totalBytes: result.root.size,
          scannedAt: new Date().toISOString(),
          largestFiles: result.largestFiles.map((f) => ({ path: f.path, size: f.size })),
          byExtension: result.byExtension,
          duplicates: dupResult?.groups
        },
        format
      )
      if (res.success) pushToast('success', `Report saved: ${res.path}`)
      else if (!res.canceled) pushToast('error', res.error ?? 'Failed to save report')
    },
    [result, dupResult, pushToast]
  )

  const openContextMenu = useCallback((node: CartItem, x: number, y: number) => {
    setCtxMenu({ node, x, y })
  }, [])

  // Keyboard navigation: Esc closes overlays, Backspace goes up, Delete deletes selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (document.activeElement?.tagName ?? '').toUpperCase()
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      if (e.key === 'Escape') {
        setCtxMenu(null)
        setDeleteTarget(null)
        setCartOpen(false)
        return
      }
      if (typing) return
      if (e.key === 'Backspace' && focusStack.length > 1) {
        e.preventDefault()
        setFocusStack((s) => s.slice(0, -1))
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        if (e.key === 'Delete') {
          e.preventDefault()
          setDeleteTarget({ node: toCartItem(selected), mode: 'trash' })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusStack.length, selected])

  const activeDrive = useMemo(
    () => drives.find((d) => rootPath.startsWith(d.mount)) ?? drives[0],
    [drives, rootPath]
  )

  const searchResults = useMemo(() => {
    if (!result || rightTab !== 'find') return []
    return searchFiles(result.root, filter)
  }, [result, filter, rightTab])

  const junkItems = useMemo(() => {
    if (!result || rightTab !== 'cleanup') return []
    return findJunk(result.root)
  }, [result, rightTab])

  const elapsedSec = scanStartedAt ? (Date.now() - scanStartedAt) / 1000 : 0
  const filesPerSec =
    scanning && elapsedSec > 0.2 && progress
      ? Math.round(progress.scanned / elapsedSec)
      : 0

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
            <button className="btn danger" onClick={() => api.cancelScan()}>
              Cancel
            </button>
          ) : (
            <button className="btn primary" onClick={() => startScan(rootPath)} disabled={!rootPath}>
              Scan
            </button>
          )}
        </div>
      </header>

      <div className="toolbar">
        <div className="toggle-group" role="group" aria-label="View mode">
          <button className={view === 'treemap' ? 'seg active' : 'seg'} onClick={() => setView('treemap')}>
            ▦ Treemap
          </button>
          <button className={view === 'sunburst' ? 'seg active' : 'seg'} onClick={() => setView('sunburst')}>
            ◎ Sunburst
          </button>
        </div>
        <div className="toggle-group" role="group" aria-label="Size metric">
          <button className={metric === 'size' ? 'seg active' : 'seg'} onClick={() => setMetric('size')}>
            Apparent size
          </button>
          <button className={metric === 'allocSize' ? 'seg active' : 'seg'} onClick={() => setMetric('allocSize')}>
            Size on disk
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={crossFs} onChange={(e) => setCrossFs(e.target.checked)} />
          Cross filesystems
        </label>
        <div className="toolbar-spacer" />
        <button className="btn ghost sm" onClick={rescanFocus} disabled={!result || scanning}>
          ⟳ Rescan folder
        </button>
        <button className="btn ghost sm" onClick={() => exportReport('json')} disabled={!result}>
          Export JSON
        </button>
        <button className="btn ghost sm" onClick={() => exportReport('csv')} disabled={!result}>
          Export CSV
        </button>
      </div>

      <main className="layout">
        <section className="viz-panel">
          <Breadcrumb stack={focusStack} onNavigate={navigateTo} />
          <div className="treemap-host" ref={treemapRef}>
            {focusNode && focusNode[metric] > 0 ? (
              view === 'treemap' ? (
                <Treemap
                  root={focusNode}
                  width={treemapSize.width}
                  height={treemapSize.height}
                  metric={metric}
                  selectedPath={selected?.path ?? null}
                  onSelect={setSelected}
                  onDrill={drillInto}
                  onContextMenu={(n, x, y) => openContextMenu(toCartItem(n), x, y)}
                />
              ) : (
                <Sunburst
                  root={focusNode}
                  width={treemapSize.width}
                  height={treemapSize.height}
                  metric={metric}
                  selectedPath={selected?.path ?? null}
                  onSelect={setSelected}
                  onDrill={drillInto}
                  onContextMenu={(n, x, y) => openContextMenu(toCartItem(n), x, y)}
                />
              )
            ) : (
              <EmptyState scanning={scanning} progress={progress} />
            )}
          </div>
        </section>

        <aside className="side-panel">
          <div className="tabs">
            {(
              [
                ['largest', 'Largest'],
                ['types', 'Types'],
                ['duplicates', 'Duplicates'],
                ['cleanup', 'Cleanup'],
                ['find', 'Find'],
                ['selection', 'Selection']
              ] as [RightTab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                className={rightTab === id ? 'tab active' : 'tab'}
                onClick={() => setRightTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="tab-body">
            {rightTab === 'largest' && (
              <LargestFiles
                files={result?.largestFiles ?? []}
                metric={metric}
                onSelect={(n) => {
                  setSelected(n)
                  setRightTab('selection')
                }}
                onAddToCart={(n) => addToCart(toCartItem(n))}
                onContextMenu={(n, x, y) => openContextMenu(toCartItem(n), x, y)}
              />
            )}
            {rightTab === 'types' && (
              <ExtensionBreakdown stats={result?.byExtension ?? []} total={result?.root.size ?? 0} />
            )}
            {rightTab === 'duplicates' && (
              <DuplicatesPanel
                running={dupRunning}
                progress={dupProgress}
                result={dupResult}
                hasScan={!!result}
                onRun={findDuplicates}
                onCancel={() => api.cancelDuplicates()}
                onAddPath={(path, size) =>
                  addToCart({ path, name: path.split('/').pop() ?? path, size, isDirectory: false })
                }
                onAddExtras={(g) =>
                  g.paths.slice(1).forEach((p) =>
                    addToCart({ path: p, name: p.split('/').pop() ?? p, size: g.size, isDirectory: false })
                  )
                }
              />
            )}
            {rightTab === 'cleanup' && (
              <CleanupPanel
                items={junkItems}
                metric={metric}
                hasScan={!!result}
                onAdd={(n) => addToCart(toCartItem(n))}
                onAddAll={(items) => items.forEach((it) => addToCart(toCartItem(it.node)))}
                onSelect={(n) => {
                  setSelected(n)
                  setRightTab('selection')
                }}
              />
            )}
            {rightTab === 'find' && (
              <FindPanel
                filter={filter}
                onChange={setFilter}
                results={searchResults}
                metric={metric}
                hasScan={!!result}
                onSelect={(n) => {
                  setSelected(n)
                }}
                onAddToCart={(n) => addToCart(toCartItem(n))}
              />
            )}
            {rightTab === 'selection' && (
              <SelectionPanel
                node={selected}
                total={result?.root[metric] ?? 0}
                metric={metric}
                inCart={selected ? cart.has(selected.path) : false}
                onReveal={(p) => api.revealInFolder(p)}
                onCopy={(p) => {
                  api.copyToClipboard(p)
                  pushToast('info', 'Path copied')
                }}
                onAddToCart={(n) => addToCart(toCartItem(n))}
                onDelete={(n, mode) => setDeleteTarget({ node: toCartItem(n), mode })}
                onOpen={(n) => drillInto(n)}
              />
            )}
          </div>
        </aside>
      </main>

      {cart.size > 0 && (
        <CartBar
          items={[...cart.values()]}
          open={cartOpen}
          onToggle={() => setCartOpen((o) => !o)}
          onClear={() => setCart(new Map())}
          onRemove={removeFromCart}
          mode={cartMode}
          onMode={setCartMode}
          busy={cartBusy}
          onDeleteAll={runBatchDelete}
        />
      )}

      <footer className="statusbar">
        <div className="status-left">
          {scanning ? (
            <span className="scanning-indicator">
              <span className="pulse" /> Scanning… {progress?.scanned ?? 0} items ·{' '}
              {formatBytes(progress?.totalBytes ?? 0)}
              {filesPerSec > 0 && <span className="rate"> · {filesPerSec.toLocaleString()}/s</span>}
              <span className="status-path">{progress?.currentPath}</span>
            </span>
          ) : result ? (
            <span>
              {result.aborted ? 'Scan cancelled · ' : 'Scan complete · '}
              {formatBytes(totalSize)} {metric === 'allocSize' ? 'on disk' : 'across this tree'}
            </span>
          ) : (
            <span>Pick a drive or folder and press Scan to begin.</span>
          )}
        </div>
        <div className="status-right">
          {freedTotal > 0 && <span className="freed-badge">Reclaimed {formatBytes(freedTotal)}</span>}
          {trashInfo?.supported && (
            <button className="trash-chip" onClick={emptyTrash} title="Empty the trash">
              {'\u{1F5D1}'} Trash {formatBytes(trashInfo.sizeBytes)}
            </button>
          )}
          {activeDrive && <DriveGauge drive={activeDrive} />}
        </div>
      </footer>

      {deleteTarget && (
        <DeleteModal
          target={deleteTarget}
          onChangeMode={(mode) => setDeleteTarget({ ...deleteTarget, mode, locked: false })}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
          onUnlock={unlockAndDelete}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={buildMenu(ctxMenu.node, {
            open: () => {
              const node = result ? findPath(result.root, ctxMenu.node.path) : null
              if (node) drillInto(node)
            },
            reveal: () => api.revealInFolder(ctxMenu.node.path),
            copy: () => {
              api.copyToClipboard(ctxMenu.node.path)
              pushToast('info', 'Path copied')
            },
            addCart: () => addToCart(ctxMenu.node),
            trash: () => setDeleteTarget({ node: ctxMenu.node, mode: 'trash' }),
            del: () => setDeleteTarget({ node: ctxMenu.node, mode: 'permanent' })
          })}
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

function buildMenu(
  node: CartItem,
  handlers: {
    open: () => void
    reveal: () => void
    copy: () => void
    addCart: () => void
    trash: () => void
    del: () => void
  }
): MenuItem[] {
  const items: MenuItem[] = []
  if (node.isDirectory) items.push({ label: 'Open in view', onClick: handlers.open })
  items.push({ label: 'Reveal in file manager', onClick: handlers.reveal })
  items.push({ label: 'Copy path', onClick: handlers.copy })
  items.push({ label: 'Add to cleanup cart', onClick: handlers.addCart })
  items.push({ label: 'Move to Trash', onClick: handlers.trash })
  items.push({ label: 'Delete permanently', onClick: handlers.del, danger: true })
  return items
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
            Choose a folder and press Scan. The treemap shows where your bytes are hiding.
          </p>
        </>
      )}
    </div>
  )
}

function LargestFiles({
  files,
  metric,
  onSelect,
  onAddToCart,
  onContextMenu
}: {
  files: FileNode[]
  metric: SizeMetric
  onSelect: (n: FileNode) => void
  onAddToCart: (n: FileNode) => void
  onContextMenu: (n: FileNode, x: number, y: number) => void
}): React.JSX.Element {
  if (files.length === 0) return <p className="panel-empty">No files scanned yet.</p>
  const max = files[0]?.[metric] ?? 1
  return (
    <ul className="file-list">
      {files.slice(0, 100).map((f) => (
        <li
          key={f.path}
          className="file-row"
          onClick={() => onSelect(f)}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextMenu(f, e.clientX, e.clientY)
          }}
        >
          <div className="file-bar-track">
            <div
              className="file-bar"
              style={{ width: `${Math.max((f[metric] / max) * 100, 2)}%`, background: colorForKey(f.path) }}
            />
          </div>
          <div className="file-meta">
            <span className="file-name" title={f.path}>{f.name}</span>
            <span className="file-size">{formatBytes(f[metric])}</span>
          </div>
          <button
            className="icon-btn cart"
            title="Add to cleanup cart"
            onClick={(e) => {
              e.stopPropagation()
              onAddToCart(f)
            }}
          >
            +
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
  if (stats.length === 0) return <p className="panel-empty">No data yet.</p>
  return (
    <ul className="ext-list">
      {stats.slice(0, 40).map((s) => (
        <li key={s.extension} className="ext-row">
          <span className="ext-swatch" style={{ background: colorForKey(s.extension) }} />
          <span className="ext-name">{s.extension}</span>
          <span className="ext-count">{s.count} files</span>
          <span className="ext-size">{formatBytes(s.size)}</span>
          <span className="ext-pct">{formatPercent(s.size, total)}</span>
        </li>
      ))}
    </ul>
  )
}

function DuplicatesPanel({
  running,
  progress,
  result,
  hasScan,
  onRun,
  onCancel,
  onAddPath,
  onAddExtras
}: {
  running: boolean
  progress: DuplicateProgress | null
  result: DuplicateResult | null
  hasScan: boolean
  onRun: () => void
  onCancel: () => void
  onAddPath: (path: string, size: number) => void
  onAddExtras: (g: DuplicateGroup) => void
}): React.JSX.Element {
  if (!hasScan) return <p className="panel-empty">Scan a folder first.</p>
  return (
    <div className="dup-panel">
      <div className="dup-head">
        {running ? (
          <button className="btn danger sm" onClick={onCancel}>Cancel</button>
        ) : (
          <button className="btn primary sm" onClick={onRun}>Find duplicates</button>
        )}
        {result && !running && (
          <span className="dup-summary">
            {result.groups.length} group(s) · {formatBytes(result.reclaimableBytes)} reclaimable
          </span>
        )}
      </div>
      {running && (
        <p className="muted small">
          {progress ? `${progress.phase}… ${progress.processed}` : 'Working…'}
          <br />
          <span className="status-path">{progress?.currentPath}</span>
        </p>
      )}
      {result && result.groups.length === 0 && !running && (
        <p className="panel-empty">No duplicates found in this folder.</p>
      )}
      {result && result.groups.length > 0 && (
        <ul className="dup-list">
          {result.groups.slice(0, 60).map((g) => (
            <li key={g.hash} className="dup-group">
              <div className="dup-group-head">
                <span className="dup-size">{formatBytes(g.size)} × {g.paths.length}</span>
                <span className="dup-wasted">save {formatBytes(g.wastedBytes)}</span>
                <button className="mini-btn" onClick={() => onAddExtras(g)} title="Add all but one to cart">
                  + extras
                </button>
              </div>
              <ul className="dup-files">
                {g.paths.map((p, i) => (
                  <li key={p} className="dup-file">
                    <span className="dup-path" title={p}>
                      {i === 0 && <span className="keep-tag">keep</span>}
                      {p}
                    </span>
                    {i > 0 && (
                      <button className="mini-btn" onClick={() => onAddPath(p, g.size)}>+</button>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CleanupPanel({
  items,
  metric,
  hasScan,
  onAdd,
  onAddAll,
  onSelect
}: {
  items: JunkItem[]
  metric: SizeMetric
  hasScan: boolean
  onAdd: (n: FileNode) => void
  onAddAll: (items: JunkItem[]) => void
  onSelect: (n: FileNode) => void
}): React.JSX.Element {
  if (!hasScan) return <p className="panel-empty">Scan a folder first.</p>
  if (items.length === 0) return <p className="panel-empty">No obvious junk found. Nice and tidy!</p>

  const byCategory = new Map<string, JunkItem[]>()
  for (const it of items) {
    const list = byCategory.get(it.category)
    if (list) list.push(it)
    else byCategory.set(it.category, [it])
  }
  const totalSize = items.reduce((a, b) => a + b.node[metric], 0)

  return (
    <div className="cleanup-panel">
      <div className="cleanup-head">
        <span className="dup-summary">
          {items.length} item(s) · {formatBytes(totalSize)}
        </span>
        <button className="btn warn sm" onClick={() => onAddAll(items)}>Add all to cart</button>
      </div>
      {[...byCategory.entries()].map(([cat, list]) => (
        <div key={cat} className="cleanup-cat">
          <h4>{cat}</h4>
          <ul className="file-list">
            {list.slice(0, 40).map((it) => (
              <li key={it.node.path} className="file-row" onClick={() => onSelect(it.node)}>
                <div className="file-meta">
                  <span className="file-name" title={it.node.path}>
                    {it.node.name} <em className="rule-tag">{it.rule}</em>
                  </span>
                  <span className="file-size">{formatBytes(it.node[metric])}</span>
                </div>
                <button
                  className="icon-btn cart"
                  title="Add to cleanup cart"
                  onClick={(e) => {
                    e.stopPropagation()
                    onAdd(it.node)
                  }}
                >
                  +
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function FindPanel({
  filter,
  onChange,
  results,
  metric,
  hasScan,
  onSelect,
  onAddToCart
}: {
  filter: SearchFilter
  onChange: (f: SearchFilter) => void
  results: FileNode[]
  metric: SizeMetric
  hasScan: boolean
  onSelect: (n: FileNode) => void
  onAddToCart: (n: FileNode) => void
}): React.JSX.Element {
  return (
    <div className="find-panel">
      <input
        className="find-input"
        placeholder="Name contains…"
        value={filter.query}
        onChange={(e) => onChange({ ...filter, query: e.target.value })}
      />
      <div className="find-row">
        <input
          className="find-input small"
          placeholder=".ext"
          value={filter.extension}
          onChange={(e) => onChange({ ...filter, extension: e.target.value })}
        />
        <select
          className="find-input small"
          value={filter.minBytes}
          onChange={(e) => onChange({ ...filter, minBytes: Number(e.target.value) })}
        >
          <option value={0}>Any size</option>
          <option value={1048576}>≥ 1 MB</option>
          <option value={10485760}>≥ 10 MB</option>
          <option value={104857600}>≥ 100 MB</option>
          <option value={1073741824}>≥ 1 GB</option>
        </select>
        <select
          className="find-input small"
          value={filter.olderThanDays}
          onChange={(e) => onChange({ ...filter, olderThanDays: Number(e.target.value) })}
        >
          <option value={0}>Any age</option>
          <option value={30}>&gt; 30 days</option>
          <option value={180}>&gt; 6 months</option>
          <option value={365}>&gt; 1 year</option>
        </select>
      </div>
      {!hasScan ? (
        <p className="panel-empty">Scan a folder first.</p>
      ) : results.length === 0 ? (
        <p className="panel-empty">No files match the filter.</p>
      ) : (
        <ul className="file-list">
          {results.map((f) => (
            <li key={f.path} className="file-row" onClick={() => onSelect(f)}>
              <div className="file-meta">
                <span className="file-name" title={f.path}>{f.name}</span>
                <span className="file-size">{formatBytes(f[metric])}</span>
              </div>
              <button
                className="icon-btn cart"
                title="Add to cleanup cart"
                onClick={(e) => {
                  e.stopPropagation()
                  onAddToCart(f)
                }}
              >
                +
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SelectionPanel({
  node,
  total,
  metric,
  inCart,
  onReveal,
  onCopy,
  onAddToCart,
  onDelete,
  onOpen
}: {
  node: FileNode | null
  total: number
  metric: SizeMetric
  inCart: boolean
  onReveal: (p: string) => void
  onCopy: (p: string) => void
  onAddToCart: (n: FileNode) => void
  onDelete: (n: FileNode, mode: DeleteMode) => void
  onOpen: (n: FileNode) => void
}): React.JSX.Element {
  if (!node) return <p className="panel-empty">Click a tile to inspect it here.</p>
  return (
    <div className="selection">
      <div className="selection-head">
        <span className="selection-kind">{node.isDirectory ? '\u{1F4C1} Folder' : '\u{1F4C4} File'}</span>
        <h3 title={node.path}>{node.name}</h3>
      </div>
      <dl className="selection-stats">
        <div>
          <dt>Apparent size</dt>
          <dd>{formatBytes(node.size)}</dd>
        </div>
        <div>
          <dt>Size on disk</dt>
          <dd>{formatBytes(node.allocSize)}</dd>
        </div>
        <div>
          <dt>Share of tree</dt>
          <dd>{formatPercent(node[metric], total)}</dd>
        </div>
        <div>
          <dt>Modified</dt>
          <dd>{formatDate(node.mtimeMs)}</dd>
        </div>
      </dl>
      <code className="selection-path">{node.path}</code>
      <div className="selection-actions">
        {node.isDirectory && (
          <button className="btn ghost" onClick={() => onOpen(node)}>Open in view</button>
        )}
        <button className="btn ghost" onClick={() => onReveal(node.path)}>Reveal</button>
        <button className="btn ghost" onClick={() => onCopy(node.path)}>Copy path</button>
        <button className="btn ghost" onClick={() => onAddToCart(node)} disabled={inCart}>
          {inCart ? 'In cart' : 'Add to cart'}
        </button>
        <button className="btn warn" onClick={() => onDelete(node, 'trash')}>Move to Trash</button>
        <button className="btn danger" onClick={() => onDelete(node, 'permanent')}>Delete permanently</button>
      </div>
    </div>
  )
}

function CartBar({
  items,
  open,
  onToggle,
  onClear,
  onRemove,
  mode,
  onMode,
  busy,
  onDeleteAll
}: {
  items: CartItem[]
  open: boolean
  onToggle: () => void
  onClear: () => void
  onRemove: (path: string) => void
  mode: DeleteMode
  onMode: (m: DeleteMode) => void
  busy: boolean
  onDeleteAll: () => void
}): React.JSX.Element {
  const total = items.reduce((a, b) => a + b.size, 0)
  return (
    <div className={`cart-bar ${open ? 'open' : ''}`}>
      <div className="cart-summary" onClick={onToggle}>
        <span className="cart-glyph">{'\u{1F6D2}'}</span>
        <strong>{items.length}</strong> item(s) · {formatBytes(total)} to reclaim
        <span className="cart-caret">{open ? '▾' : '▴'}</span>
      </div>
      {open && (
        <div className="cart-body">
          <ul className="cart-list">
            {items.map((it) => (
              <li key={it.path} className="cart-item">
                <span className="file-name" title={it.path}>{it.name}</span>
                <span className="file-size">{formatBytes(it.size)}</span>
                <button className="mini-btn" onClick={() => onRemove(it.path)}>✕</button>
              </li>
            ))}
          </ul>
          <div className="cart-actions">
            <div className="mode-toggle inline">
              <label className={mode === 'trash' ? 'on' : ''}>
                <input type="radio" checked={mode === 'trash'} onChange={() => onMode('trash')} />
                Trash
              </label>
              <label className={mode === 'permanent' ? 'on' : ''}>
                <input type="radio" checked={mode === 'permanent'} onChange={() => onMode('permanent')} />
                Permanent
              </label>
            </div>
            <button className="btn ghost sm" onClick={onClear} disabled={busy}>Clear</button>
            <button
              className={mode === 'permanent' ? 'btn danger sm' : 'btn warn sm'}
              onClick={onDeleteAll}
              disabled={busy}
            >
              {busy ? 'Deleting…' : `Delete ${items.length} · ${formatBytes(total)}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function DriveGauge({ drive }: { drive: DriveInfo }): React.JSX.Element {
  const usedPct = (drive.usedBytes / drive.totalBytes) * 100
  return (
    <div className="drive-gauge" title={`${drive.label} (${drive.mount})`}>
      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: `${usedPct}%` }} />
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
              <input type="radio" checked={target.mode === 'trash'} onChange={() => onChangeMode('trash')} />
              Move to Trash (recoverable)
            </label>
            <label className={target.mode === 'permanent' ? 'on' : ''}>
              <input type="radio" checked={target.mode === 'permanent'} onChange={() => onChangeMode('permanent')} />
              Delete permanently
            </label>
          </div>
        )}

        {target.locked && (
          <div className="lock-info">
            <p>{target.error}</p>
            <p className="muted">These processes are holding the path open:</p>
            <ul className="lock-list">
              {target.lockingProcesses?.map((p) => (
                <li key={p.pid}>
                  <strong>{p.command}</strong> · pid {p.pid} · {p.user}
                </li>
              ))}
            </ul>
            <p className="muted small">Unlocking terminates these processes so the path can be deleted.</p>
          </div>
        )}

        {target.error && !target.locked && <p className="modal-error">{target.error}</p>}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          {target.locked ? (
            <button className="btn danger" onClick={onUnlock} disabled={target.working}>
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
