import { expect, test } from 'claude-code/testing'

import { ensureEngine, findPython, type EngineCtx, type PythonInfo } from './engine'

type Run = { exitCode: number; stdout: string; stderr: string }
const ok = (stdout = ''): Run => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr = ''): Run => ({ exitCode: 1, stdout: '', stderr })

type Handler = (argv: readonly string[]) => Run | Promise<Run>

function fake(handler: Handler, files: Record<string, string> = {}, env: Record<string, string> = {}) {
  const calls: { argv: readonly string[]; init?: { timeoutMs?: number } }[] = []
  const writes: Record<string, string> = {}
  const existing = new Set(Object.keys(files))
  const $: EngineCtx = {
    process: {
      run: async (argv, init) => {
        calls.push({ argv, init })
        return handler(argv)
      },
    },
    fs: {
      read: async (p) => {
        if (p in writes) return writes[p] ?? ''
        if (p in files) return files[p] ?? ''
        throw new Error('ENOENT ' + p)
      },
      write: async (p, t) => {
        writes[p] = t
        existing.add(p)
      },
      exists: async (p) => existing.has(p) || p in writes,
    },
    env: { get: async (n) => env[n] },
    ui: { status: () => undefined },
  }
  return { $, calls, writes, existing }
}

const has = (argv: readonly string[], s: string) => argv.includes(s)
const probeOut = (v: unknown) => ok(JSON.stringify(v))

test('no python: every candidate fails, error names python.org and 3.10', async () => {
  const { $ } = fake(() => fail('nope'))
  const r = await findPython($)
  expect('error' in r && r.error.includes('python.org') && r.error.includes('3.10')).toBe(true)
})

test('old python is rejected', async () => {
  const { $ } = fake((argv) => (argv[0] === 'python3' ? probeOut([[3, 8], 'win32', 'C:\\Users\\a']) : fail()))
  expect('error' in (await findPython($))).toBe(true)
})

const EXE = (argv: readonly string[], exe: string): Run | undefined =>
  argv.some((a) => a.includes('sys.executable')) ? ok(exe + '\n') : undefined

const PPID = (argv: readonly string[], pid: string): Run | undefined =>
  argv.some((a) => a.includes('getppid')) ? ok(pid + '\n') : undefined

test('probe gives platform and home, and argv is the resolved interpreter', async () => {
  const mac = fake((argv) => PPID(argv, '4242') ?? EXE(argv, '/usr/bin/python3') ?? probeOut([[3, 12], 'darwin', '/Users/a']))
  expect(await findPython(mac.$)).toEqual({ argv: ['/usr/bin/python3'], platform: 'darwin', home: '/Users/a', sessionPid: 4242 })
})

test('the session pid is learned with the resolved interpreter, not a launcher', async () => {
  const f = fake((argv) => {
    if (argv[0] === 'py') return EXE(argv, 'C:/Py312/python.exe') ?? probeOut([[3, 12], 'win32', 'C:/Users/a'])
    if (argv[0] === 'C:/Py312/python.exe') return PPID(argv, '4242') ?? fail()
    return fail()
  })
  const py = (await findPython(f.$)) as PythonInfo
  expect(py.sessionPid).toBe(4242)
  const probe = f.calls.find((c) => c.argv.some((a) => a.includes('getppid')))
  expect(probe?.argv[0]).toBe('C:/Py312/python.exe')
})

test('no session pid stops the start with a reason', async () => {
  const f = fake((argv) => PPID(argv, 'nope') ?? EXE(argv, '/usr/bin/python3') ?? probeOut([[3, 12], 'darwin', '/Users/a']))
  const r = await findPython(f.$)
  expect('error' in r && r.error.includes('Claude Code')).toBe(true)
})

test('py -3 resolves to the real interpreter, and the lock probe runs with it', async () => {
  const f = fake(
    (argv) => {
      if (argv[0] === 'py') return EXE(argv, 'C:/Py312/python.exe') ?? probeOut([[3, 12], 'win32', 'C:/Users/a'])
      if (argv.some((a) => a.includes('getppid'))) return ok('4242\n')
      return argv[0] === 'C:/Py312/python.exe' ? ok() : fail()
    },
    REQ,
  )
  const py = (await findPython(f.$)) as PythonInfo
  expect(py.argv).toEqual(['C:/Py312/python.exe'])
  await ensureEngine(f.$, py, 'deepgram', ROOT)
  const lockProbe = f.calls.find((c) => c.argv.some((a) => a.includes('getppid')))
  expect(lockProbe?.argv[0]).toBe('C:/Py312/python.exe')
})

test('home falls back to the environment', async () => {
  const a = fake((argv) => PPID(argv, '4242') ?? EXE(argv, 'python') ?? probeOut([[3, 12], 'win32', '']), {}, { USERPROFILE: 'C:\\Users\\a' })
  expect(((await findPython(a.$)) as PythonInfo).home).toBe('C:\\Users\\a')
  const b = fake((argv) => PPID(argv, '4242') ?? EXE(argv, 'python') ?? probeOut([[3, 12], 'darwin', '']), {}, { HOME: '/Users/b' })
  expect(((await findPython(b.$)) as PythonInfo).home).toBe('/Users/b')
  const c = fake((argv) => EXE(argv, 'python') ?? probeOut([[3, 12], 'darwin', '']))
  const r = await findPython(c.$)
  expect('error' in r && r.error.includes('USERPROFILE') && r.error.includes('HOME')).toBe(true)
})

const ROOT = '/plug'
const REQ = { [`${ROOT}/engine/requirements.txt`]: 'a==1\n', [`${ROOT}/engine/requirements-whisper.txt`]: 'w==1\n' }
const PY: PythonInfo = { argv: ['python3'], platform: 'darwin', home: '/Users/a', sessionPid: 4242 }
const VENV = '/Users/a/.claude-desk-mic/venv'
const LOCK = '/Users/a/.claude-desk-mic/install.lock'

// Default handler: everything succeeds, ppid is 4242.
const happy: Handler = (argv) => (argv.some((a) => a.includes('getppid')) ? ok('4242\n') : ok())
const pips = (calls: { argv: readonly string[]; init?: { timeoutMs?: number } }[]) => calls.filter((c) => has(c.argv, 'pip'))

test('fresh install: venv, one pip run per file, stamp last, lock removed', async () => {
  const f = fake(happy, REQ)
  const r = await ensureEngine(f.$, PY, 'whisper', ROOT)
  expect(r).toEqual({ python: `${VENV}/bin/python` })
  expect(f.calls.some((c) => has(c.argv, '-m') && has(c.argv, 'venv'))).toBe(true)
  expect(pips(f.calls).length).toBe(2)
  expect(Object.keys(f.writes)).toContain(`${VENV}/.desk-mic-reqs`)
  const last = f.calls[f.calls.length - 1]!
  expect(last.argv.join(' ')).toContain('os.remove')
  expect(last.argv[last.argv.length - 1]).toBe(LOCK)
})

test('windows venv python path', async () => {
  const f = fake(happy, REQ)
  const r = await ensureEngine(f.$, { ...PY, platform: 'win32', home: 'C:\\Users\\a' }, 'deepgram', ROOT)
  expect(r).toEqual({ python: 'C:\\Users\\a/.claude-desk-mic/venv/Scripts/python.exe' })
})

test('up to date: no pip run', async () => {
  const first = fake(happy, REQ)
  await ensureEngine(first.$, PY, 'deepgram', ROOT)
  const second = fake(happy, { ...REQ, ...first.writes })
  second.existing.add(`${VENV}/bin/python`)
  expect(await ensureEngine(second.$, PY, 'deepgram', ROOT)).toEqual({ python: `${VENV}/bin/python` })
  expect(pips(second.calls).length).toBe(0)
})

test('pip failure writes no stamp and names the last stderr line', async () => {
  let n = 0
  const f = fake((argv) => {
    if (has(argv, 'pip')) return ++n === 2 ? fail('warn\nERROR: No matching distribution\n') : ok()
    return happy(argv)
  }, REQ)
  const r = await ensureEngine(f.$, PY, 'whisper', ROOT)
  expect('error' in r && r.error.includes('ERROR: No matching distribution')).toBe(true)
  expect(Object.keys(f.writes).some((p) => p.endsWith('.desk-mic-reqs'))).toBe(false)
})

test('failed venv is removed', async () => {
  const f = fake((argv) => (has(argv, 'venv') ? fail('boom') : happy(argv)), REQ)
  const r = await ensureEngine(f.$, PY, 'deepgram', ROOT)
  expect('error' in r).toBe(true)
  expect(f.calls.some((c) => c.argv.join(' ').includes('shutil.rmtree') && c.argv[c.argv.length - 1] === VENV)).toBe(true)
})

test('venv creation and pip get the ten-minute cap', async () => {
  const f = fake(happy, REQ)
  await ensureEngine(f.$, PY, 'deepgram', ROOT)
  const venvCall = f.calls.find((c) => has(c.argv, 'venv'))
  expect(venvCall?.init?.timeoutMs).toBe(600000)
  expect(pips(f.calls)[0]?.init?.timeoutMs).toBe(600000)
})

test('pip timeout is retryable', async () => {
  let timeout = true
  const f = fake((argv) => {
    if (has(argv, 'pip') && timeout) throw new Error('timeout')
    return happy(argv)
  }, REQ)
  const r = await ensureEngine(f.$, PY, 'deepgram', ROOT)
  expect('error' in r && r.error.includes('timed out')).toBe(true)
  expect(Object.keys(f.writes).some((p) => p.endsWith('.desk-mic-reqs'))).toBe(false)
  expect(f.calls.some((c) => c.argv.join(' ').includes('os.remove') && c.argv[c.argv.length - 1] === LOCK)).toBe(true)
  timeout = false
  const before = pips(f.calls).length
  expect(await ensureEngine(f.$, PY, 'deepgram', ROOT)).toEqual({ python: `${VENV}/bin/python` })
  expect(pips(f.calls).length).toBe(before + 1)
})

test('interrupted install (venv, no stamp) is retried', async () => {
  const f = fake(happy, REQ)
  f.existing.add(`${VENV}/bin/python`)
  await ensureEngine(f.$, PY, 'deepgram', ROOT)
  expect(pips(f.calls).length).toBe(1)
  expect(f.calls.some((c) => has(c.argv, 'venv'))).toBe(false)
})

test('two concurrent starts install once', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((res) => (release = res))
  const f = fake(async (argv) => {
    if (has(argv, 'pip')) await gate
    return happy(argv)
  }, REQ)
  const a = ensureEngine(f.$, PY, 'deepgram', ROOT)
  const b = await ensureEngine(f.$, PY, 'deepgram', ROOT)
  expect('error' in b && b.error.includes('already installing')).toBe(true)
  release()
  await a
  expect(pips(f.calls).length).toBe(1)
})

test('pip -r paths are absolute under the plugin root', async () => {
  const f = fake(happy, REQ)
  await ensureEngine(f.$, PY, 'whisper', ROOT)
  const argvs = pips(f.calls).map((c) => c.argv)
  expect(argvs[0]).toContain(`${ROOT}/engine/requirements.txt`)
  expect(argvs[1]).toContain(`${ROOT}/engine/requirements-whisper.txt`)
  for (const a of argvs) expect(a.some((x) => x.startsWith('engine/'))).toBe(false)
})

test('install already running elsewhere', async () => {
  const f = fake((argv) => (argv[0] === 'kill' ? ok() : happy(argv)), { ...REQ, [LOCK]: '999' })
  const r = await ensureEngine(f.$, PY, 'deepgram', ROOT)
  expect('error' in r && r.error.includes('another session')).toBe(true)
  expect(pips(f.calls).length).toBe(0)
})

test('a dead pid lock is taken over', async () => {
  const f = fake((argv) => (argv[0] === 'kill' ? fail() : happy(argv)), { ...REQ, [LOCK]: '999' })
  expect(await ensureEngine(f.$, PY, 'deepgram', ROOT)).toEqual({ python: `${VENV}/bin/python` })
})
