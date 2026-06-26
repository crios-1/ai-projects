export interface FileNode {
  /** Absolute path of this file or directory. */
  path: string
  /** Base name (last path segment). */
  name: string
  /** Total size in bytes (recursive for directories). */
  size: number
  /** True if this node is a directory. */
  isDirectory: boolean
  /** Last modified time as epoch milliseconds. */
  mtimeMs: number
  /** Child nodes (directories only). Undefined for files. */
  children?: FileNode[]
}

export interface ScanProgress {
  /** Path currently being scanned. */
  currentPath: string
  /** Number of entries (files + dirs) visited so far. */
  scanned: number
  /** Total bytes accounted for so far. */
  totalBytes: number
}

export interface ScanResult {
  root: FileNode
  /** Flat list of the largest individual files found during the scan. */
  largestFiles: FileNode[]
  /** Aggregated size per file extension. */
  byExtension: ExtensionStat[]
  /** Wall-clock duration of the scan in milliseconds. */
  durationMs: number
  /** Whether the scan was aborted before completion. */
  aborted: boolean
}

export interface ExtensionStat {
  extension: string
  size: number
  count: number
}

export interface DriveInfo {
  /** Mount point / drive root path. */
  mount: string
  /** Human label for the drive. */
  label: string
  totalBytes: number
  freeBytes: number
  usedBytes: number
}

export interface LockingProcess {
  pid: number
  command: string
  user: string
}

export interface DeleteResult {
  success: boolean
  path: string
  /** Freed bytes (best-effort, equals reported node size). */
  freedBytes: number
  /** Set when deletion failed because the path was locked by a process. */
  locked?: boolean
  lockingProcesses?: LockingProcess[]
  error?: string
}

export interface UnlockResult {
  success: boolean
  path: string
  killedPids: number[]
  error?: string
}

export type DeleteMode = 'trash' | 'permanent'

/** The API surface exposed to the renderer via the preload bridge. */
export interface SpaceInvaderApi {
  listDrives: () => Promise<DriveInfo[]>
  pickDirectory: () => Promise<string | null>
  scan: (rootPath: string) => Promise<ScanResult>
  cancelScan: () => Promise<void>
  onScanProgress: (cb: (progress: ScanProgress) => void) => () => void
  deletePath: (path: string, mode: DeleteMode) => Promise<DeleteResult>
  findLockingProcesses: (path: string) => Promise<LockingProcess[]>
  unlockPath: (path: string) => Promise<UnlockResult>
  revealInFolder: (path: string) => Promise<void>
  getHomeDir: () => Promise<string>
}
