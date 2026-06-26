import { contextBridge, ipcRenderer } from 'electron'
import type {
  SpaceInvaderApi,
  ScanProgress,
  ScanOptions,
  DeleteMode,
  DuplicateProgress,
  ReportPayload
} from '../shared/types'

const api: SpaceInvaderApi = {
  listDrives: () => ipcRenderer.invoke('drives:list'),
  pickDirectory: () => ipcRenderer.invoke('dir:pick'),
  scan: (rootPath: string, options?: ScanOptions) =>
    ipcRenderer.invoke('scan:start', rootPath, options ?? {}),
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
  copyToClipboard: (text: string) =>
    ipcRenderer.invoke('clipboard:write', text),
  getHomeDir: () => ipcRenderer.invoke('env:home'),
  findDuplicates: (rootPath: string, minSize: number) =>
    ipcRenderer.invoke('dup:find', rootPath, minSize),
  cancelDuplicates: () => ipcRenderer.invoke('dup:cancel'),
  onDuplicateProgress: (cb: (p: DuplicateProgress) => void) => {
    const listener = (_e: unknown, p: DuplicateProgress): void => cb(p)
    ipcRenderer.on('dup:progress', listener)
    return () => ipcRenderer.removeListener('dup:progress', listener)
  },
  getTrashInfo: () => ipcRenderer.invoke('trash:info'),
  emptyTrash: () => ipcRenderer.invoke('trash:empty'),
  saveReport: (payload: ReportPayload, format: 'json' | 'csv') =>
    ipcRenderer.invoke('report:save', payload, format)
}

contextBridge.exposeInMainWorld('spaceInvader', api)
