import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  clipboard
} from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { promises as fs } from 'fs'
import { Worker } from 'worker_threads'
import { DuplicateFinder } from './duplicates'
import {
  listDrives,
  deletePath,
  findLockingProcesses,
  unlockPath,
  revealInFolder,
  getTrashInfo,
  emptyTrash
} from './fileops'
import type {
  DeleteMode,
  ScanOptions,
  ScanResult,
  ReportPayload
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
let activeScanWorker: Worker | null = null
let activeDuplicateFinder: DuplicateFinder | null = null

// On Linux the Chromium sandbox requires a correctly configured setuid helper,
// which is frequently unavailable in headless / containerized environments.
// Disable it there so the app can launch reliably.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 660,
    show: false,
    backgroundColor: '#0a0a16',
    title: 'Space Invader',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Runs a disk scan in a worker thread so the main process stays responsive. */
function runScan(
  rootPath: string,
  options: ScanOptions,
  onProgress: (p: unknown) => void
): Promise<ScanResult> {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(join(__dirname, 'scan-worker.js'), {
      workerData: { rootPath, options }
    })
    activeScanWorker = worker

    worker.on('message', (msg: any) => {
      if (msg?.type === 'progress') {
        onProgress(msg.progress)
      } else if (msg?.type === 'result') {
        resolvePromise(msg.result as ScanResult)
      } else if (msg?.type === 'error') {
        reject(new Error(msg.error))
      }
    })
    worker.on('error', reject)
    worker.on('exit', () => {
      if (activeScanWorker === worker) activeScanWorker = null
    })
  })
}

function registerIpc(): void {
  ipcMain.handle('drives:list', () => listDrives())

  ipcMain.handle('dir:pick', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Choose a folder to scan'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'scan:start',
    async (event, rootPath: string, options: ScanOptions = {}) => {
      activeScanWorker?.postMessage({ type: 'abort' })
      const result = await runScan(rootPath, options, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('scan:progress', progress)
        }
      })
      return result
    }
  )

  ipcMain.handle('scan:cancel', () => {
    activeScanWorker?.postMessage({ type: 'abort' })
  })

  ipcMain.handle(
    'dup:find',
    async (event, rootPath: string, minSize: number) => {
      activeDuplicateFinder?.abort()
      const finder = new DuplicateFinder((p) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('dup:progress', p)
        }
      })
      activeDuplicateFinder = finder
      const result = await finder.find(rootPath, minSize)
      if (activeDuplicateFinder === finder) activeDuplicateFinder = null
      return result
    }
  )

  ipcMain.handle('dup:cancel', () => {
    activeDuplicateFinder?.abort()
  })

  ipcMain.handle('fs:delete', (_e, path: string, mode: DeleteMode) =>
    deletePath(path, mode)
  )

  ipcMain.handle('fs:findLocks', (_e, path: string) =>
    findLockingProcesses(path)
  )

  ipcMain.handle('fs:unlock', (_e, path: string) => unlockPath(path))

  ipcMain.handle('fs:reveal', (_e, path: string) => revealInFolder(path))

  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('trash:info', () => getTrashInfo())

  ipcMain.handle('trash:empty', () => emptyTrash())

  ipcMain.handle('env:home', () => homedir())

  ipcMain.handle(
    'report:save',
    async (_e, payload: ReportPayload, format: 'json' | 'csv') => {
      if (!mainWindow) return { success: false, error: 'No window' }
      const defaultName = `space-invader-report.${format}`
      const dlg = await dialog.showSaveDialog(mainWindow, {
        title: 'Save disk report',
        defaultPath: defaultName,
        filters: [
          {
            name: format.toUpperCase(),
            extensions: [format]
          }
        ]
      })
      if (dlg.canceled || !dlg.filePath) {
        return { success: false, canceled: true }
      }
      try {
        const content =
          format === 'json' ? toJsonReport(payload) : toCsvReport(payload)
        await fs.writeFile(dlg.filePath, content, 'utf8')
        return { success: true, path: dlg.filePath }
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) }
      }
    }
  )
}

function toJsonReport(payload: ReportPayload): string {
  return JSON.stringify(payload, null, 2)
}

function toCsvReport(payload: ReportPayload): string {
  const lines: string[] = []
  lines.push(`Space Invader report,${payload.rootPath}`)
  lines.push(`Scanned at,${payload.scannedAt}`)
  lines.push(`Total bytes,${payload.totalBytes}`)
  lines.push('')
  lines.push('Largest files')
  lines.push('size_bytes,path')
  for (const f of payload.largestFiles) {
    lines.push(`${f.size},"${f.path.replace(/"/g, '""')}"`)
  }
  lines.push('')
  lines.push('By extension')
  lines.push('extension,size_bytes,count')
  for (const e of payload.byExtension) {
    lines.push(`${e.extension},${e.size},${e.count}`)
  }
  if (payload.duplicates?.length) {
    lines.push('')
    lines.push('Duplicate groups')
    lines.push('size_bytes,wasted_bytes,copies,paths')
    for (const g of payload.duplicates) {
      const paths = g.paths.map((p) => p.replace(/"/g, '""')).join(' | ')
      lines.push(`${g.size},${g.wastedBytes},${g.paths.length},"${paths}"`)
    }
  }
  return lines.join('\n')
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
