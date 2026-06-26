/**
 * Integration test for the lock-detection + unlock subsystem.
 *
 * On Linux the kernel allows deleting files that are held open, so the GUI's
 * "locked" branch is primarily exercised on Windows. This test verifies the
 * underlying machinery directly: that `findLockingProcesses` discovers a
 * process holding a file open (via lsof) and that `unlockPath` terminates it.
 *
 * Run with: node --experimental-strip-types test/unlock.integration.ts
 */
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findLockingProcesses, unlockPath } from '../src/main/fileops.ts'

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`\u274c FAIL: ${msg}`)
    process.exitCode = 1
    throw new Error(msg)
  }
  console.log(`\u2705 ${msg}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const file = join(tmpdir(), `si-lock-${Date.now()}.bin`)
  await fs.writeFile(file, 'hold me open')

  // `tail -f` opens the file for reading and keeps the descriptor open.
  // unref() so this child never keeps the test's event loop alive.
  const holder = spawn('tail', ['-f', file], { stdio: 'ignore' })
  holder.unref()
  const holderPid = holder.pid!

  try {
    assert(typeof holderPid === 'number', `holder process started (pid ${holderPid})`)
    await delay(500)

    const locks = await findLockingProcesses(file)
    console.log('  detected locks:', JSON.stringify(locks))
    assert(locks.length > 0, 'findLockingProcesses detected at least one holder')
    assert(
      locks.some((l) => l.pid === holderPid),
      `findLockingProcesses found the holder pid ${holderPid}`
    )
    assert(
      locks.some((l) => l.command.includes('tail')),
      'detected holder command is "tail"'
    )

    const result = await unlockPath(file)
    console.log('  unlock result:', JSON.stringify(result))
    assert(result.success, 'unlockPath reports success (path no longer locked)')
    assert(
      result.killedPids.includes(holderPid),
      `unlockPath terminated the holder pid ${holderPid}`
    )

    await delay(300)
    assert(!isAlive(holderPid), 'holder process is no longer alive after unlock')

    const after = await findLockingProcesses(file)
    assert(after.length === 0, 'no processes hold the path after unlock')

    console.log('\n\u2705 ALL UNLOCK SUBSYSTEM CHECKS PASSED')
  } finally {
    try {
      process.kill(holderPid, 'SIGKILL')
    } catch {
      // already gone
    }
    await fs.rm(file, { force: true })
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    // Ensure a prompt, deterministic exit regardless of lingering handles.
    process.exit(process.exitCode ?? 0)
  })
