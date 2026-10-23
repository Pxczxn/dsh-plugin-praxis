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
    confirmations: [],
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
    hint: 'Retry after that process finishes. A lock left by a local process that has exited is recovered immediately; on another host it is only recovered after 10 minutes.',
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
    if (error?.code === 'ENOENT') {
      // 替换过程中崩溃会留下完整备份却没有 state.json。这里必须把备份捞回来：
      // 当成空状态继续跑，下一次写入就会拿空对象覆盖掉全部历史。
      const recovered = await readBackupFile(statePath)
      if (recovered) return recovered
      return emptyState()
    }
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
 * state.json 不在时，从替换失败留下的备份恢复。备份本身损坏或不存在就返回
 * null —— 损坏的状态坚持报错，不静默当空状态。
 */
async function readBackupFile(statePath) {
  const backupPath = `${statePath}.bak`
  let raw
  try {
    raw = await fs.readFile(backupPath, 'utf8')
  } catch {
    return null
  }
  if (raw.trim() === '') return null
  let state
  try {
    state = normalizeState(JSON.parse(raw), backupPath)
  } catch {
    return null
  }
  // 恢复后把备份扶正，免得它在下一次成功写入之后变成过期副本。
  await fs.rename(backupPath, statePath).catch(() => {})
  return state
}

async function fileExists(path) {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * CONTRACT §2: temp file in the same directory -> write + fsync -> rename.
 * 替换失败时先把旧文件挪到 state.json.bak，绝不先删除再写；任一步失败都尽量
 * 把旧状态放回原位，并把完整的新状态留在临时文件里（keepTmp）供人工恢复。
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
      // 有些文件系统不允许 rename 覆盖已存在的目标。这里不能先删旧文件再写：
      // 一旦旧文件被删，任何后续失败或崩溃都会让磁盘上不再有完整状态，下一次
      // load 会把它当成空状态并覆盖掉全部历史。改为把旧文件原子挪到备份位。
      const backupPath = `${statePath}.bak`
      let backedUp = false
      await fs.rm(backupPath, { force: true }).catch(() => {})
      try {
        await fs.rename(statePath, backupPath)
        backedUp = true
      } catch {
        backedUp = false
      }
      let replaced = false
      if (backedUp) {
        try {
          await fs.rename(tmpPath, statePath)
          replaced = true
        } catch {
          // 替换失败就把旧状态放回原位，一次写失败不能变成数据丢失。
          await fs.rename(backupPath, statePath).catch(() => {})
        }
      }
      if (replaced) {
        await fs.rm(backupPath, { force: true }).catch(() => {})
      } else {
        // 只有目标位置此刻确实空着才用 copyFile 兜底。覆盖一个尚存的旧状态
        // 可能写成半截文件，那才是真正的数据破坏。
        const occupied = await fileExists(statePath)
        if (!occupied) {
          try {
            await fs.copyFile(tmpPath, statePath)
            replaced = true
          } catch (copyError) {
            const error = new Error(
              `atomic replace failed (${renameError?.code ?? 'rename refused'}): ` +
                `${copyError?.message ?? copyError}; complete state left at ${tmpPath}`,
            )
            error.keepTmp = true
            throw error
          }
        } else {
          const error = new Error(
            `atomic replace failed (${renameError?.code ?? 'rename refused'}); ` +
              `previous state left in place, complete new state at ${tmpPath}`,
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
    let meta
    try {
      meta = JSON.parse(await fs.readFile(this.lockPath, 'utf8'))
    } catch {
      return
    }
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return
    // 同机持锁进程还活着就绝不抢占，哪怕锁已经很旧。同机持锁进程已经退出时不必
    // 等满 10 分钟：那个进程不可能再写，继续拒绝只会让宿主崩溃之后的一段时间
    // 完全无法记录。跨机看不到对方的进程表，只能在超时后回收。
    const sameHost = meta.host === hostname()
    const ownerAlive = sameHost && processAlive(Number(meta.pid))
    const expired = Date.now() - info.mtimeMs >= LOCK_STALE_MS
    if (ownerAlive) return
    if (!sameHost && !expired) return
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
