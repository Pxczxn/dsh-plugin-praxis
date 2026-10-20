// Durable Praxis state: a single JSON file, atomic replace, a cross-process
// lock and an in-process serial queue. Corrupt or newer state is refused and
// left on disk, never reset.

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { PraxisError } from './evidence.js'

export const STATE_VERSION = 2

/** A lock older than this may be recovered, and only when it is provably dead. */
export const LOCK_STALE_MS = 10 * 60 * 1000

const COLLECTIONS = ['tasks', 'observations', 'requests', 'lessons']

/** `DSH_PRAXIS_DATA_DIR` wins, then `~/.dsh/praxis`. */
export function defaultDir() {
  const configured = process.env.DSH_PRAXIS_DATA_DIR
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return join(home, '.dsh', 'praxis')
}

/** CONTRACT §1: collections are arrays, `sessions` is a diagnostic map. */
export function emptyState() {
  return {
    version: STATE_VERSION,
    nextObservation: 1,
    tasks: [],
    observations: [],
    requests: [],
    lessons: [],
    sessions: {},
  }
}

function corruptError(where, detail) {
  return new PraxisError('state-corrupt', `praxis state is corrupt (${where}): ${detail}; refusing to overwrite it.`, {
    hint: 'Inspect or move the file away, then restart. Nothing was written.',
    changed: false,
  })
}

function versionError(where, version) {
  const seen = version === undefined ? 'no version field' : `version=${JSON.stringify(version)}`
  return new PraxisError(
    'unsupported-version',
    `praxis state at ${where} has ${seen}; this build only reads and writes version ${STATE_VERSION} and does not migrate automatically.`,
    {
      hint: 'Back up or migrate the file by hand before writing. Nothing was written.',
      changed: false,
    },
  )
}

function lockBusyError(lockPath) {
  return new PraxisError('lock-busy', `praxis state is locked by another process: ${lockPath}`, {
    hint: 'Retry after that process finishes. A lock is only recovered after 10 minutes when its owner is provably gone.',
    changed: false,
  })
}

/** Validates one parsed document and returns a state this build can own. */
function normalizeState(parsed, where) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corruptError(where, 'the JSON root is not an object')
  }
  if (parsed.version === undefined) {
    const carriesData =
      'sessions' in parsed || COLLECTIONS.some(name => Object.prototype.hasOwnProperty.call(parsed, name))
    if (carriesData) throw versionError(where, undefined)
    return emptyState()
  }
  if (parsed.version !== STATE_VERSION) throw versionError(where, parsed.version)

  const state = { ...emptyState(), ...parsed, version: STATE_VERSION }
  for (const name of COLLECTIONS) {
    if (!Array.isArray(state[name])) throw corruptError(where, `"${name}" must be an array`)
  }
  if (state.sessions === null || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) {
    throw corruptError(where, '"sessions" must be an object')
  }
  if (!Number.isInteger(state.nextObservation) || state.nextObservation < 1) state.nextObservation = 1
  return state
}

/** Read-only: a missing or empty file means a fresh v2 state, nothing is written. */
async function readStateFile(statePath) {
  let raw
  try {
    raw = await fs.readFile(statePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState()
    throw error
  }
  if (raw.trim() === '') return emptyState()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw corruptError(statePath, 'not valid JSON')
  }
  return normalizeState(parsed, statePath)
}

/**
 * CONTRACT §2: temp file in the same directory -> write + fsync -> rename.
 * A failed rename falls back to copyFile. On any failure the temp file is
 * removed and the previous state.json is left untouched.
 */
async function atomicWrite(statePath, state) {
  const tmpPath = join(dirname(statePath), `state.json.tmp-${randomUUID()}`)
  const body = `${JSON.stringify(state, null, 2)}\n`
  try {
    const handle = await fs.open(tmpPath, 'wx', 0o600)
    try {
      await handle.writeFile(body, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await fs.rename(tmpPath, statePath)
    } catch (renameError) {
      // Some filesystems refuse rename onto an existing file. Remove the target
      // and retry: if that rename also fails, the complete new state is still in
      // the temp file, whereas copyFile straight over state.json can leave a
      // half-written file when it fails midway.
      let replaced = false
      try {
        await fs.rm(statePath, { force: true })
        await fs.rename(tmpPath, statePath)
        replaced = true
      } catch {
        replaced = false
      }
      if (!replaced) {
        try {
          await fs.copyFile(tmpPath, statePath)
          replaced = true
        } catch (copyError) {
          // Keep the only complete copy of the new state for manual recovery.
          const error = new Error(
            `atomic replace failed (${renameError?.code ?? 'rename refused'}): ` +
              `${copyError?.message ?? copyError}; complete state left at ${tmpPath}`,
          )
          error.keepTmp = true
          throw error
        }
      }
    }
  } catch (error) {
    if (!error?.keepTmp) await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
  await fs.rm(tmpPath, { force: true }).catch(() => {})
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

class StateStore {
  constructor(directory) {
    this.dir = directory
    this.statePath = join(directory, 'state.json')
    this.lockPath = join(directory, 'state.lock')
    /** @type {object|null} last loaded/mutated snapshot, never read from disk */
    this.cached = null
    /** @type {Promise<unknown>} in-process serial queue for mutate() */
    this.queue = Promise.resolve()
  }

  async ensureDir() {
    // Mode is meaningful on POSIX, best effort on Windows. An existing
    // directory is left alone.
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
  }

  /** Returns true only when this process created the lock file. */
  async tryCreateLock() {
    let handle
    try {
      handle = await fs.open(this.lockPath, 'wx', 0o600)
    } catch (error) {
      if (error?.code === 'EEXIST') return false
      throw error
    }
    try {
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() })}\n`,
        'utf8',
      )
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => {})
      await fs.rm(this.lockPath, { force: true }).catch(() => {})
      throw error
    }
    await handle.close().catch(() => {})
    return true
  }

  /**
   * Removes `state.lock` only when it is stale AND its owner is provably gone
   * (another host, or a local pid that no longer exists). Anything we cannot
   * confirm is left alone so the caller reports `lock-busy`.
   */
  async dropStaleLock() {
    let info
    try {
      info = await fs.stat(this.lockPath)
    } catch {
      return
    }
    if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return
    let meta
    try {
      meta = JSON.parse(await fs.readFile(this.lockPath, 'utf8'))
    } catch {
      return
    }
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return
    if (meta.host === hostname() && processAlive(Number(meta.pid))) return
    await fs.rm(this.lockPath, { force: true }).catch(() => {})
  }

  async acquireLock() {
    await this.ensureDir()
    if (await this.tryCreateLock()) return
    await this.dropStaleLock()
    if (await this.tryCreateLock()) return
    throw lockBusyError(this.lockPath)
  }

  async releaseLock() {
    await fs.rm(this.lockPath, { force: true }).catch(() => {})
  }

  /** Reads the current state from disk without writing. */
  async load() {
    const state = await readStateFile(this.statePath)
    this.cached = state
    return state
  }

  /**
   * CONTRACT §2: lock -> re-read -> mutate -> atomic write -> unlock.
   * Resolves with whatever `mutator` returned, or the new state when it
   * returned `undefined` (so `await store.mutate(fn)` can be used either way).
   */
  mutate(mutator) {
    const execute = async () => {
      await this.acquireLock()
      try {
        const state = await readStateFile(this.statePath)
        const result = await mutator(state)
        await atomicWrite(this.statePath, state)
        this.cached = state
        return result === undefined ? state : result
      } finally {
        await this.releaseLock()
      }
    }
    const task = this.queue.then(execute, execute)
    this.queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  /** Last snapshot seen by load()/mutate(); no IO, `null` before the first one. */
  read() {
    return this.cached
  }
}

/**
 * @param {{ dir?: string }} [options]
 * @returns {StateStore}
 */
export function createStore({ dir } = {}) {
  const directory = typeof dir === 'string' && dir.trim() !== '' ? dir : defaultDir()
  return new StateStore(directory)
}
