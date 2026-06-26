import { parentPort, workerData } from 'worker_threads'
import { DiskScanner } from './scanner'
import type { ScanOptions } from '../shared/types'

interface WorkerInput {
  rootPath: string
  options: ScanOptions
}

const { rootPath, options } = workerData as WorkerInput
const port = parentPort

if (!port) {
  throw new Error('scan-worker must be run as a worker thread')
}

const scanner = new DiskScanner((progress) => {
  port.postMessage({ type: 'progress', progress })
}, options)

port.on('message', (msg: { type: string }) => {
  if (msg?.type === 'abort') scanner.abort()
})

scanner
  .scan(rootPath)
  .then((result) => {
    port.postMessage({ type: 'result', result })
  })
  .catch((err: unknown) => {
    port.postMessage({
      type: 'error',
      error: err instanceof Error ? err.message : String(err)
    })
  })
