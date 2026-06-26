import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { DiskScanner } from './scanner'
import {
  listDrives,
  deletePath,
  findLockingProcesses,
  unlockPath,
  revealInFolder
} from './fileops'
import type { DeleteMode, ScanProgress } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let activeScanner: DiskScanner | null = null

// On Linux the Chromium sandbox requires a correctly configured setuid helper,
// which is frequently unavailable in headless / containerized environments.
// Disable it there so the app can launch reliably.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 640,
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

  ipcMain.handle('scan:start', async (event, rootPath: string) => {
    activeScanner?.abort()
    const scanner = new DiskScanner((progress: ScanProgress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('scan:progress', progress)
      }
    })
    activeScanner = scanner
    const result = await scanner.scan(rootPath)
    if (activeScanner === scanner) activeScanner = null
    return result
  })

  ipcMain.handle('scan:cancel', () => {
    activeScanner?.abort()
  })

  ipcMain.handle('fs:delete', (_e, path: string, mode: DeleteMode) =>
    deletePath(path, mode)
  )

  ipcMain.handle('fs:findLocks', (_e, path: string) =>
    findLockingProcesses(path)
  )

  ipcMain.handle('fs:unlock', (_e, path: string) => unlockPath(path))

  ipcMain.handle('fs:reveal', (_e, path: string) => revealInFolder(path))

  ipcMain.handle('env:home', () => homedir())
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
