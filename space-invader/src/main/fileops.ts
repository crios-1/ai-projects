import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { homedir, platform, userInfo } from 'os'
import { resolve, join, sep } from 'path'
import type {
  DriveInfo,
  LockingProcess,
  DeleteResult,
  UnlockResult,
  DeleteMode,
  TrashInfo,
  EmptyTrashResult
} from '../shared/types'

const execFileAsync = promisify(execFile)
const LSOF_TIMEOUT_MS = 8000

/**
 * Paths that must never be deleted: filesystem roots, the user's home, and
 * critical system directories. Deleting these would damage the OS or the user
 * account, so they are rejected before any delete is attempted.
 */
export function isProtectedPath(targetPath: string): boolean {
  const p = resolve(targetPath).replace(/[/\\]+$/, '') || sep
  const home = resolve(homedir())

  if (p === sep || /^[a-zA-Z]:\\?$/.test(p)) return true
  if (p === home) return true

  const roots =
    platform() === 'win32'
      ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)']
      : [
          '/bin',
          '/sbin',
          '/usr',
          '/lib',
          '/lib64',
          '/etc',
          '/boot',
          '/dev',
          '/proc',
          '/sys',
          '/var',
          '/System',
          '/Library',
          '/Applications',
          '/private',
          '/home',
          '/Users'
        ]
  return roots.some((r) => p === r)
}

/**
 * Lists logical drives / mount points along with capacity information.
 * Falls back gracefully to the filesystem root and home directory.
 */
export async function listDrives(): Promise<DriveInfo[]> {
  const candidates = new Set<string>()
  const home = homedir()
  candidates.add(home)

  if (platform() === 'win32') {
    for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const root = `${String.fromCharCode(c)}:\\`
      try {
        await fs.access(root)
        candidates.add(root)
      } catch {
        // drive letter not present
      }
    }
  } else {
    candidates.add('/')
    for (const base of ['/media', '/mnt', '/Volumes']) {
      try {
        const mounts = await fs.readdir(base)
        for (const m of mounts) candidates.add(`${base}/${m}`)
      } catch {
        // base mount dir absent
      }
    }
  }

  const drives: DriveInfo[] = []
  for (const mount of candidates) {
    try {
      const stats = await fs.statfs(mount)
      const totalBytes = stats.blocks * stats.bsize
      const freeBytes = stats.bavail * stats.bsize
      if (totalBytes <= 0) continue
      drives.push({
        mount,
        label: labelFor(mount, home),
        totalBytes,
        freeBytes,
        usedBytes: totalBytes - freeBytes
      })
    } catch {
      // statfs unsupported for this path
    }
  }

  return dedupeByMount(drives)
}

function labelFor(mount: string, home: string): string {
  if (mount === home) return 'Home'
  if (mount === '/') return 'System Root'
  return mount
}

function dedupeByMount(drives: DriveInfo[]): DriveInfo[] {
  const seen = new Set<string>()
  const out: DriveInfo[] = []
  for (const d of drives) {
    if (seen.has(d.mount)) continue
    seen.add(d.mount)
    out.push(d)
  }
  return out
}

/**
 * Finds processes that currently hold the given path (file or directory) open,
 * using `lsof`. Returns an empty list if lsof is unavailable or nothing holds
 * the path.
 */
export async function findLockingProcesses(
  targetPath: string
): Promise<LockingProcess[]> {
  if (platform() === 'win32') {
    return findLockingProcessesWindows(targetPath)
  }

  let isDir = false
  try {
    isDir = (await fs.stat(targetPath)).isDirectory()
  } catch {
    return []
  }

  const args = isDir
    ? ['-w', '-F', 'pcL', '+D', targetPath]
    : ['-w', '-F', 'pcL', '--', targetPath]

  let stdout = ''
  try {
    const res = await execFileAsync('lsof', args, {
      timeout: LSOF_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 16
    })
    stdout = res.stdout
  } catch (err: any) {
    // lsof exits non-zero when there are no matches; treat that as "no locks".
    stdout = err?.stdout ?? ''
  }

  return parseLsof(stdout)
}

/**
 * Windows lock discovery via Sysinternals `handle.exe` if it is available on
 * PATH. handle.exe is not bundled (its EULA forbids redistribution), so this
 * returns an empty list when the tool is absent.
 */
async function findLockingProcessesWindows(
  targetPath: string
): Promise<LockingProcess[]> {
  let stdout = ''
  try {
    const res = await execFileAsync('handle.exe', ['-nobanner', targetPath], {
      timeout: LSOF_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 16
    })
    stdout = res.stdout
  } catch (err: any) {
    stdout = err?.stdout ?? ''
  }

  // Lines look like: "node.exe           pid: 1234   type: File          ..."
  const byPid = new Map<number, LockingProcess>()
  const re = /^(\S+)\s+pid:\s*(\d+)/i
  for (const line of stdout.split(/\r?\n/)) {
    const m = re.exec(line.trim())
    if (!m) continue
    const pid = Number(m[2])
    if (pid > 0 && !byPid.has(pid)) {
      byPid.set(pid, { pid, command: m[1], user: '' })
    }
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid)
}

/**
 * Parses `lsof -F pcL` machine-readable output. Output is a sequence of
 * per-process blocks: a `p<pid>` line followed by `c<command>` and `L<login>`
 * lines. A new `p` line (or end of output) flushes the current process.
 */
function parseLsof(stdout: string): LockingProcess[] {
  const byPid = new Map<number, LockingProcess>()
  let pid = 0
  let command = ''
  let user = ''

  const flush = (): void => {
    if (pid > 0 && !byPid.has(pid)) {
      byPid.set(pid, { pid, command, user })
    }
  }

  for (const line of stdout.split('\n')) {
    if (!line) continue
    const type = line[0]
    const value = line.slice(1)
    if (type === 'p') {
      flush()
      pid = Number(value)
      command = ''
      user = ''
    } else if (type === 'c') {
      command = value
    } else if (type === 'L') {
      user = value
    }
  }
  flush()

  return [...byPid.values()].sort((a, b) => a.pid - b.pid)
}

/**
 * Deletes a path either by moving it to the OS trash or permanently. If a
 * permanent delete fails because the path is locked, the result includes the
 * locking processes so the UI can offer to unlock and retry.
 */
export async function deletePath(
  targetPath: string,
  mode: DeleteMode
): Promise<DeleteResult> {
  if (isProtectedPath(targetPath)) {
    return {
      success: false,
      path: targetPath,
      freedBytes: 0,
      protected: true,
      error: 'This path is protected and cannot be deleted.'
    }
  }

  let freedBytes = 0
  try {
    freedBytes = await pathSize(targetPath)
  } catch {
    freedBytes = 0
  }

  if (mode === 'trash') {
    try {
      const { shell } = await import('electron')
      await shell.trashItem(targetPath)
      return { success: true, path: targetPath, freedBytes }
    } catch (err: any) {
      return {
        success: false,
        path: targetPath,
        freedBytes: 0,
        error: err?.message ?? String(err)
      }
    }
  }

  try {
    await fs.rm(targetPath, { recursive: true, force: true })
    return { success: true, path: targetPath, freedBytes }
  } catch (err: any) {
    const locking = await findLockingProcesses(targetPath)
    if (locking.length > 0) {
      return {
        success: false,
        path: targetPath,
        freedBytes: 0,
        locked: true,
        lockingProcesses: locking,
        error: 'Path is locked by one or more running processes.'
      }
    }
    const code = err?.code
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        success: false,
        path: targetPath,
        freedBytes: 0,
        permissionDenied: true,
        error: `Permission denied. Try running Space Invader with elevated privileges (current user: ${currentUser()}).`
      }
    }
    return {
      success: false,
      path: targetPath,
      freedBytes: 0,
      error: err?.message ?? String(err)
    }
  }
}

/**
 * Attempts to release a locked path by terminating the processes that hold it
 * open. Sends SIGTERM first, then SIGKILL to any survivors. Never targets PID 1
 * or the Space Invader process itself.
 */
export async function unlockPath(targetPath: string): Promise<UnlockResult> {
  if (platform() === 'win32') {
    return {
      success: false,
      path: targetPath,
      killedPids: [],
      error: 'Unlocking is not supported on Windows in this build.'
    }
  }

  const locking = await findLockingProcesses(targetPath)
  const me = process.pid
  const targets = locking
    .map((p) => p.pid)
    .filter((pid) => pid > 1 && pid !== me)

  const killed: number[] = []
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM')
      killed.push(pid)
    } catch {
      // process may already be gone, or we lack permission
    }
  }

  await delay(400)

  for (const pid of killed) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // ignore
      }
    }
  }

  await delay(200)
  const stillLocked = await findLockingProcesses(targetPath)
  return {
    success: stillLocked.length === 0,
    path: targetPath,
    killedPids: killed,
    error:
      stillLocked.length === 0
        ? undefined
        : `Path is still locked by ${stillLocked.length} process(es). They may require elevated privileges (current user: ${currentUser()}).`
  }
}

export async function revealInFolder(targetPath: string): Promise<void> {
  const { shell } = await import('electron')
  shell.showItemInFolder(targetPath)
}

/**
 * Returns the location and aggregate size of the user's Trash. Implemented for
 * the freedesktop.org trash (Linux) and macOS `~/.Trash`. On Windows the
 * Recycle Bin is not enumerable without extra APIs, so it reports unsupported.
 */
export async function getTrashInfo(): Promise<TrashInfo> {
  const locations = trashLocations()
  if (locations.length === 0) {
    return { supported: false, locations: [], sizeBytes: 0, itemCount: 0 }
  }

  let sizeBytes = 0
  let itemCount = 0
  for (const dir of locations) {
    try {
      const entries = await fs.readdir(dir)
      itemCount += entries.length
      for (const name of entries) {
        try {
          sizeBytes += await pathSize(join(dir, name))
        } catch {
          // skip unreadable item
        }
      }
    } catch {
      // trash dir does not exist yet
    }
  }
  return { supported: true, locations, sizeBytes, itemCount }
}

export async function emptyTrash(): Promise<EmptyTrashResult> {
  const info = await getTrashInfo()
  if (!info.supported) {
    return {
      success: false,
      freedBytes: 0,
      error: 'Emptying the trash is not supported on this platform.'
    }
  }

  const dirs =
    platform() === 'darwin'
      ? info.locations
      : info.locations.flatMap((d) => [d, d.replace(/\/files$/, '/info')])

  try {
    for (const dir of dirs) {
      let entries: string[] = []
      try {
        entries = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const name of entries) {
        await fs.rm(join(dir, name), { recursive: true, force: true })
      }
    }
    return { success: true, freedBytes: info.sizeBytes }
  } catch (err: any) {
    return {
      success: false,
      freedBytes: 0,
      error: err?.message ?? String(err)
    }
  }
}

/** Returns the directories whose contents constitute the user's trash. */
function trashLocations(): string[] {
  const home = homedir()
  if (platform() === 'darwin') {
    return [join(home, '.Trash')]
  }
  if (platform() === 'win32') {
    return []
  }
  const dataHome =
    process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim()
      ? process.env.XDG_DATA_HOME
      : join(home, '.local', 'share')
  return [join(dataHome, 'Trash', 'files')]
}

async function pathSize(targetPath: string): Promise<number> {
  const stat = await fs.lstat(targetPath)
  if (!stat.isDirectory()) return stat.size
  let total = 0
  const entries = await fs.readdir(targetPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const child = `${targetPath}/${entry.name}`
    try {
      total += await pathSize(child)
    } catch {
      // skip unreadable child
    }
  }
  return total
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function currentUser(): string {
  try {
    return userInfo().username
  } catch {
    return 'unknown'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
