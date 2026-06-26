import { contextBridge, ipcRenderer } from 'electron'
import type {
  SpaceInvaderApi,
  ScanProgress,
  DeleteMode
} from '../shared/types'

const api: SpaceInvaderApi = {
  listDrives: () => ipcRenderer.invoke('drives:list'),
  pickDirectory: () => ipcRenderer.invoke('dir:pick'),
  scan: (rootPath: string) => ipcRenderer.invoke('scan:start', rootPath),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  onScanProgress: (cb: (progress: ScanProgress) => void) => {
    const listener = (_e: unknown, progress: ScanProgress): void =>
      cb(progress)
    ipcRenderer.on('scan:progress', listener)
    return () => ipcRenderer.removeListener('scan:progress', listener)
  },
  deletePath: (path: string, mode: DeleteMode) =>
    ipcRenderer.invoke('fs:delete', path, mode),
  findLockingProcesses: (path: string) =>
    ipcRenderer.invoke('fs:findLocks', path),
  unlockPath: (path: string) => ipcRenderer.invoke('fs:unlock', path),
  revealInFolder: (path: string) => ipcRenderer.invoke('fs:reveal', path),
  getHomeDir: () => ipcRenderer.invoke('env:home')
}

contextBridge.exposeInMainWorld('spaceInvader', api)
