export interface FileNode {
  /** Absolute path of this file or directory. */
  path: string
  /** Base name (last path segment). */
  name: string
  /** Apparent (logical) size in bytes (recursive for directories). */
  size: number
  /** Allocated size on disk in bytes (block-rounded; recursive for dirs). */
  allocSize: number
  /** True if this node is a directory. */
  isDirectory: boolean
  /** Last modified time as epoch milliseconds. */
  mtimeMs: number
  /** Last access time as epoch milliseconds. */
  atimeMs: number
  /** Child nodes (directories only). Undefined for files. */
  children?: FileNode[]
}

/** Which size metric to visualize / aggregate by. */
export type SizeMetric = 'size' | 'allocSize'

export interface ScanOptions {
  /** When false (default), the scan does not descend into other filesystems. */
  crossFilesystems?: boolean
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
  /** Set when deletion failed due to insufficient permissions. */
  permissionDenied?: boolean
  /** Set when the target is on the protected-path blocklist. */
  protected?: boolean
  error?: string
}

export interface UnlockResult {
  success: boolean
  path: string
  killedPids: number[]
  error?: string
}

export type DeleteMode = 'trash' | 'permanent'

export interface DuplicateGroup {
  hash: string
  /** Size in bytes of each file in the group. */
  size: number
  paths: string[]
  /** Bytes that could be reclaimed by keeping a single copy. */
  wastedBytes: number
}

export interface DuplicateResult {
  groups: DuplicateGroup[]
  /** Total reclaimable bytes across all groups. */
  reclaimableBytes: number
  filesHashed: number
  durationMs: number
  aborted: boolean
}

export interface DuplicateProgress {
  phase: 'sizing' | 'hashing'
  processed: number
  total: number
  currentPath: string
}

export interface TrashInfo {
  supported: boolean
  /** Primary trash location(s). */
  locations: string[]
  sizeBytes: number
  itemCount: number
}

export interface EmptyTrashResult {
  success: boolean
  freedBytes: number
  error?: string
}

export interface ReportPayload {
  rootPath: string
  totalBytes: number
  scannedAt: string
  largestFiles: { path: string; size: number }[]
  byExtension: ExtensionStat[]
  duplicates?: DuplicateGroup[]
}

export interface SaveReportResult {
  success: boolean
  path?: string
  canceled?: boolean
  error?: string
}

/** The API surface exposed to the renderer via the preload bridge. */
export interface SpaceInvaderApi {
  listDrives: () => Promise<DriveInfo[]>
  pickDirectory: () => Promise<string | null>
  scan: (rootPath: string, options?: ScanOptions) => Promise<ScanResult>
  cancelScan: () => Promise<void>
  onScanProgress: (cb: (progress: ScanProgress) => void) => () => void
  deletePath: (path: string, mode: DeleteMode) => Promise<DeleteResult>
  findLockingProcesses: (path: string) => Promise<LockingProcess[]>
  unlockPath: (path: string) => Promise<UnlockResult>
  revealInFolder: (path: string) => Promise<void>
  copyToClipboard: (text: string) => Promise<void>
  getHomeDir: () => Promise<string>
  findDuplicates: (rootPath: string, minSize: number) => Promise<DuplicateResult>
  cancelDuplicates: () => Promise<void>
  onDuplicateProgress: (cb: (p: DuplicateProgress) => void) => () => void
  getTrashInfo: () => Promise<TrashInfo>
  emptyTrash: () => Promise<EmptyTrashResult>
  saveReport: (payload: ReportPayload, format: 'json' | 'csv') => Promise<SaveReportResult>
}
