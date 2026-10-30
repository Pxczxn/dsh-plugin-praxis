// CONTRACT §2: init, transactions, the cross-process lock, atomic writes and
// the version/corruption refusals. Every case gets its own data directory.

import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fsNs } from 'node:fs'
import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { LOCK_STALE_MS, STATE_VERSION, createStore, defaultDir, emptyState } from '../src/store.js'
import { PraxisError } from '../src/evidence.js'

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-store-'))
  process.env.DSH_PRAXIS_DATA_DIR = dir
  const statePath = join(dir, 'state.json')
  const lockPath = join(dir, 'state.lock')
  return {
    dir,
    store: createStore({ dir }),
    statePath,
    lockPath,
    cleanup: async () => {
      await chmod(dir, 0o700).catch(() => {})
      await chmod(statePath, 0o600).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function missing(path) {
  try {
    await stat(path)
    return false
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
}

function ageLock(path, ms) {
  const past = new Date(Date.now() - ms)
  return utimes(path, past, past)
}

test('defaultDir prefers DSH_PRAXIS_DATA_DIR and otherwise uses ~/.dsh/praxis', () => {
  const previous = process.env.DSH_PRAXIS_DATA_DIR
  try {
    const override = join(tmpdir(), 'praxis-override')
    process.env.DSH_PRAXIS_DATA_DIR = override
    assert.equal(defaultDir(), override)

    process.env.DSH_PRAXIS_DATA_DIR = ''
    const home = process.env.HOME || process.env.USERPROFILE || '.'
    assert.equal(defaultDir(), join(home, '.dsh', 'praxis'))
  } finally {
    if (previous === undefined) delete process.env.DSH_PRAXIS_DATA_DIR
    else process.env.DSH_PRAXIS_DATA_DIR = previous
  }
})

test('a missing state file loads as empty v2 and writes nothing', async () => {
  const { store, statePath, cleanup } = await scratch()
  try {
    assert.equal(store.read(), null, 'read() is empty before the first load')
    const state = await store.load()
    assert.equal(state.version, STATE_VERSION)
    assert.deepEqual(state.tasks, [])
    assert.deepEqual(state.observations, [])
    assert.deepEqual(state.requests, [])
    assert.deepEqual(state.lessons, [])
    assert.deepEqual(state.sessions, {})
    assert.equal(state.nextObservation, 1)
    assert.equal(store.read(), state, 'load() caches the snapshot')
    assert.equal(await missing(statePath), true, 'load() must not create the file')
  } finally {
    await cleanup()
  }
})

test('an empty state file becomes v2 on the next mutate', async () => {
  const { store, statePath, cleanup } = await scratch()
  try {
    await writeFile(statePath, '')
    const state = await store.mutate(document => {
      document.observations.push({ id: 'obs-1' })
    })
    assert.equal(state.version, STATE_VERSION)
    assert.deepEqual(state.observations, [{ id: 'obs-1' }])
    const disk = await readJson(statePath)
    assert.equal(disk.version, 2)
    assert.deepEqual(disk.observations, [{ id: 'obs-1' }])
  } finally {
    await cleanup()
  }
})

test('a versionless document with no data is treated as empty', async () => {
  const { store, statePath, cleanup } = await scratch()
  try {
    await writeFile(statePath, '{}')
    const state = await store.load()
    assert.equal(state.version, STATE_VERSION)
    assert.deepEqual(state.observations, [])
  } finally {
    await cleanup()
  }
})

test('mutate returns the mutator result, persists atomically and leaves no temp file', async () => {
  const { dir, store, statePath, cleanup } = await scratch()
  try {
    const result = await store.mutate(state => {
      state.nextObservation = 4
      state.tasks.push({ id: 't1', goal: 'ship it' })
      return { ok: true }
    })
    assert.deepEqual(result, { ok: true })
    const disk = await readJson(statePath)
    assert.equal(disk.nextObservation, 4)
    assert.deepEqual(disk.tasks.map(task => task.id), ['t1'])

    // A transaction re-reads from disk instead of trusting the cache.
    assert.equal(await store.mutate(state => state.nextObservation), 4)
    assert.deepEqual(await readdir(dir), ['state.json'])
  } finally {
    await cleanup()
  }
})

test('concurrent mutate calls are serialized by the in-process queue', async () => {
  const { store, statePath, cleanup } = await scratch()
  try {
    const transactions = Array.from({ length: 8 }, () =>
      store.mutate(async state => {
        await new Promise(resolve => setTimeout(resolve, 5))
        state.observations.push({ id: `obs-${state.observations.length + 1}` })
      }),
    )
    await Promise.all(transactions)
    const disk = await readJson(statePath)
    assert.deepEqual(
      disk.observations.map(observation => observation.id),
      ['obs-1', 'obs-2', 'obs-3', 'obs-4', 'obs-5', 'obs-6', 'obs-7', 'obs-8'],
    )
  } finally {
    await cleanup()
  }
})

test('a fresh lock held by a live process refuses the write', async () => {
  const { store, statePath, lockPath, cleanup } = await scratch()
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }))
    const error = await store.mutate(state => { state.nextObservation = 9 }).then(() => null, e => e)
    assert.ok(error instanceof PraxisError, `expected PraxisError, got ${error}`)
    assert.equal(error.code, 'lock-busy')
    assert.equal(error.changed, false)
    await assert.rejects(store.mutate(state => { state.nextObservation = 9 }), e => e.code === 'lock-busy')
    assert.equal(await missing(statePath), true, 'a refused write must not create state.json')
    assert.equal(await missing(lockPath), false, 'a foreign fresh lock must be preserved')
  } finally {
    await cleanup()
  }
})

test('a stale lock whose owner is gone is recovered', async () => {
  const { store, lockPath, cleanup } = await scratch()
  try {
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2147483646, host: hostname(), at: Date.now() - LOCK_STALE_MS * 2 }),
    )
    await ageLock(lockPath, LOCK_STALE_MS + 60_000)
    const value = await store.mutate(state => {
      state.nextObservation = 6
      return state.nextObservation
    })
    assert.equal(value, 6)
    assert.equal(await missing(lockPath), true, 'the recovered lock must be released')
  } finally {
    await cleanup()
  }
})

test('a stale lock whose local owner is alive is not stolen', async () => {
  const { store, statePath, lockPath, cleanup } = await scratch()
  try {
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() - LOCK_STALE_MS * 2 }),
    )
    await ageLock(lockPath, LOCK_STALE_MS + 60_000)
    await assert.rejects(store.mutate(state => { state.nextObservation = 3 }), e => e.code === 'lock-busy')
    assert.equal(await missing(lockPath), false)
    assert.equal(await missing(statePath), true)
  } finally {
    await cleanup()
  }
})

test('corrupt JSON is refused and never overwritten', async () => {
  const { store, statePath, lockPath, cleanup } = await scratch()
  try {
    const body = '{"version": 2, "tasks": ['
    await writeFile(statePath, body)
    await assert.rejects(store.load(), e => e.code === 'state-corrupt')
    await assert.rejects(store.mutate(state => { state.nextObservation = 7 }), e => e.code === 'state-corrupt')
    assert.equal(await readFile(statePath, 'utf8'), body, 'the unreadable file must stay on disk')
    assert.equal(await missing(lockPath), true, 'the lock is released on refusal')
  } finally {
    await cleanup()
  }
})

test('version 1 state is refused, not migrated or overwritten', async () => {
  const { store, statePath, cleanup } = await scratch()
  try {
    const legacy = JSON.stringify({ version: 1, tasks: { a: { id: 'a' } } })
    await writeFile(statePath, legacy)
    await assert.rejects(store.load(), e => e.code === 'unsupported-version')
    await assert.rejects(store.mutate(() => {}), e => e.code === 'unsupported-version')
    assert.equal(await readFile(statePath, 'utf8'), legacy)
  } finally {
    await cleanup()
  }
})

test('a newer, mistyped or unversioned state that carries data is refused', async () => {
  const documents = [
    { version: 3, tasks: [] },
    { version: '2', tasks: [] },
    { tasks: [] },
    { sessions: {} },
  ]
  for (const document of documents) {
    const { store, statePath, cleanup } = await scratch()
    const body = JSON.stringify(document)
    try {
      await writeFile(statePath, body)
      const error = await store.load().then(() => null, e => e)
      assert.ok(error instanceof PraxisError, `expected a refusal for ${body}`)
      assert.equal(error.code, 'unsupported-version', `unexpected code for ${body}`)
      assert.equal(await readFile(statePath, 'utf8'), body)
    } finally {
      await cleanup()
    }
  }
})

test('a v2 document with object-shaped collections is refused', async () => {
  const { store, statePath, cleanup } = await scratch()
  try {
    const body = JSON.stringify({
      version: 2,
      tasks: {},
      observations: [],
      requests: [],
      lessons: [],
      sessions: {},
    })
    await writeFile(statePath, body)
    await assert.rejects(store.load(), e => e.code === 'state-corrupt')
    assert.equal(await readFile(statePath, 'utf8'), body)
  } finally {
    await cleanup()
  }
})

test('a refused replace never leaves a half-written state behind', async () => {
  const { dir, store, statePath, cleanup } = await scratch()
  try {
    await store.mutate(state => { state.observations.push({ id: 'obs-1' }) })
    const before = await readFile(statePath, 'utf8')

    // Refuse the replace: a read-only target refuses rename on Windows, and the
    // read-only directory refuses the temp/lock file on POSIX.
    await chmod(statePath, 0o444)
    await chmod(dir, 0o500)
    let failed = false
    try {
      await store.mutate(state => { state.observations.push({ id: 'obs-2' }) })
    } catch {
      failed = true
    }
    await chmod(dir, 0o700)
    await chmod(statePath, 0o644)

    const after = await readFile(statePath, 'utf8')
    if (failed) {
      assert.equal(after, before, 'the old file must be intact')
    } else {
      // Removing the target and renaming the finished temp file in is a whole
      // replacement; what must never happen is a truncated file.
      assert.deepEqual(
        JSON.parse(after).observations.map(observation => observation.id),
        ['obs-1', 'obs-2'],
      )
    }
    assert.deepEqual(
      (await readdir(dir)).filter(name => name.includes('.tmp-')),
      [],
      'no temp file may be left behind',
    )
    const reopened = createStore({ dir })
    const state = await reopened.load()
    assert.deepEqual(state.observations.map(o => o.id), failed ? ['obs-1'] : ['obs-1', 'obs-2'])
    assert.equal(store.read().observations.length, state.observations.length, 'cache matches disk')
  } finally {
    await cleanup()
  }
})

test('a throwing mutator writes nothing and releases the lock', async () => {
  const { store, statePath, lockPath, cleanup } = await scratch()
  try {
    await store.mutate(state => { state.observations.push({ id: 'obs-1' }) })
    const before = await readFile(statePath, 'utf8')
    await assert.rejects(store.mutate(() => { throw new Error('boom') }), /boom/)
    assert.equal(await readFile(statePath, 'utf8'), before)
    assert.equal(await missing(lockPath), true)
    assert.equal(store.read().observations.length, 1)
    assert.equal(await store.mutate(state => state.observations.length), 1)
  } finally {
    await cleanup()
  }
})

test('a second store re-reads the state written by the first', async () => {
  const { dir, store, cleanup } = await scratch()
  try {
    const other = createStore({ dir })
    await store.mutate(state => { state.observations.push({ id: 'obs-1' }) })
    await other.mutate(state => { state.observations.push({ id: 'obs-2' }) })
    const disk = await readJson(join(dir, 'state.json'))
    assert.deepEqual(disk.observations.map(observation => observation.id), ['obs-1', 'obs-2'])
    assert.equal(store.read().observations.length, 1, 'read() is a memory snapshot, not a disk read')
  } finally {
    await cleanup()
  }
})

test('emptyState hands out fresh collections on every call', () => {
  const first = emptyState()
  first.tasks.push({ id: 'x' })
  assert.deepEqual(emptyState().tasks, [])
  assert.equal(emptyState().version, STATE_VERSION)
})

test('替换失败时旧状态留在原位，不会出现没有状态文件的窗口', async () => {
  const { dir, store, cleanup } = await scratch()
  try {
    await store.mutate(state => { state.observations.push({ id: 'obs-keep' }) })
    const statePath = join(dir, 'state.json')
    const before = await readFile(statePath, 'utf8')

    // 模拟「目标被占用、rename 无法覆盖」：tmp -> state.json 必定失败。
    const original = fsNs.rename
    const patched = mock.method(fsNs, 'rename', async (from, to) => {
      if (to === statePath && String(from).includes('.tmp-')) {
        const error = new Error('EPERM: target busy')
        error.code = 'EPERM'
        throw error
      }
      return original(from, to)
    })
    try {
      await assert.rejects(
        store.mutate(state => { state.observations.push({ id: 'obs-new' }) }),
        /atomic replace failed/,
      )
    } finally {
      patched.mock.restore()
    }

    assert.equal(await readFile(statePath, 'utf8'), before, '旧状态必须逐字不变')
    const entries = await readdir(dir)
    assert.equal(entries.some(name => name.endsWith('.bak')), false, '失败后不能留下备份文件')
    assert.equal(entries.some(name => name.includes('.tmp-')), true, '完整的新状态应保留在临时文件里')

    const reloaded = await createStore({ dir }).load()
    assert.deepEqual(reloaded.observations.map(item => item.id), ['obs-keep'])
  } finally {
    await cleanup()
  }
})

test('state.json 缺失但备份完整时恢复历史，而不是当成空状态', async () => {
  const { dir, store, cleanup } = await scratch()
  try {
    await store.mutate(state => { state.observations.push({ id: 'obs-keep' }) })
    const statePath = join(dir, 'state.json')
    // 崩溃窗口：旧文件已挪到备份位，新文件还没就位。
    await fsNs.rename(statePath, `${statePath}.bak`)

    const recovered = await createStore({ dir }).load()
    assert.deepEqual(recovered.observations.map(item => item.id), ['obs-keep'])
    assert.equal(await stat(statePath).then(() => true, () => false), true, '恢复后应把备份扶正')
    const entries = await readdir(dir)
    assert.equal(entries.some(name => name.endsWith('.bak')), false)
  } finally {
    await cleanup()
  }
})

test('持锁进程已退出时立即回收锁，不用等满 10 分钟', async () => {
  const { dir, store, lockPath, cleanup } = await scratch()
  try {
    // 起一个立刻退出的子进程，用它的 pid 伪造一把「锁还新鲜、持有者已死」的锁。
    const dead = spawnSync(process.execPath, ['-e', '0'])
    await writeFile(lockPath, JSON.stringify({ pid: dead.pid, host: hostname(), at: Date.now() }))

    await store.mutate(state => { state.observations.push({ id: 'obs-live' }) })
    const disk = await readJson(join(dir, 'state.json'))
    assert.deepEqual(disk.observations.map(item => item.id), ['obs-live'])
    assert.equal(await stat(lockPath).then(() => true, () => false), false, '锁必须被释放')
  } finally {
    await cleanup()
  }
})
