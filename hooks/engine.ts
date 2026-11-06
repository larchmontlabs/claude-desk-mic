// First-run engine setup for desk-mic: find a usable Python, build the private
// venv at <home>/.claude-desk-mic/venv, and install the requirements into it.
// The mod has no OS API and no file delete, so the platform and the home folder
// come from one Python probe, and deletes run through Python helpers.

type RunResult = { exitCode: number; stdout: string; stderr: string }

// The part of the mod's `$` this file uses. Kept structural so tests can fake it.
export type EngineCtx = {
  process: { run: (argv: readonly string[], init?: { timeoutMs?: number; stdin?: string }) => Promise<RunResult> }
  fs: {
    read: (path: string) => Promise<string>
    write: (path: string, text: string) => Promise<void>
    exists: (path: string) => Promise<boolean>
  }
  env: { get: (name: string) => Promise<string | undefined> }
  ui: { status: (text: string | undefined) => void }
}

export type PythonInfo = { argv: string[]; platform: 'win32' | 'darwin'; home: string }

// The API's documented maximum for $.process.run; used for venv creation and each pip run.
const TEN_MINUTES = 600000
const MIN_PYTHON: [number, number] = [3, 10]
const CANDIDATES: string[][] = [['python3'], ['python'], ['py', '-3']]
const PROBE =
  'import sys,pathlib,json; print(json.dumps([list(sys.version_info[:2]), sys.platform, str(pathlib.Path.home())]))'
const NO_PYTHON =
  'desk-mic needs Python 3.10 or newer, and none was found. Install it from https://www.python.org/downloads/ and run /mic again.'

function versionOk(v: unknown): boolean {
  if (!Array.isArray(v) || typeof v[0] !== 'number' || typeof v[1] !== 'number') return false
  return v[0] > MIN_PYTHON[0] || (v[0] === MIN_PYTHON[0] && v[1] >= MIN_PYTHON[1])
}

export async function findPython($: EngineCtx): Promise<PythonInfo | { error: string }> {
  for (const argv of CANDIDATES) {
    let out: RunResult
    try {
      out = await $.process.run([...argv, '-c', PROBE])
    } catch {
      continue
    }
    if (out.exitCode !== 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(out.stdout.trim())
    } catch {
      continue
    }
    if (!Array.isArray(parsed) || !versionOk(parsed[0])) continue
    const platform = parsed[1]
    if (platform !== 'win32' && platform !== 'darwin') {
      return { error: `desk-mic supports Windows and macOS only (this Python reports "${String(platform)}").` }
    }
    let home = typeof parsed[2] === 'string' ? parsed[2].trim() : ''
    if (!home) {
      home = ((await $.env.get('USERPROFILE')) ?? '').trim() || ((await $.env.get('HOME')) ?? '').trim()
    }
    if (!home) {
      return { error: 'desk-mic could not find your home folder: Python reported none and neither USERPROFILE nor HOME is set.' }
    }
    // `py -3` is a launcher that exits at once; resolve to the real interpreter so
    // os.getppid() in later probes is the session's pid, not the launcher's.
    let resolved = argv
    try {
      const exe = await $.process.run([...argv, '-c', 'import sys;print(sys.executable)'])
      const path = exe.stdout.trim()
      if (exe.exitCode === 0 && path) resolved = [path]
    } catch {
      // keep the original argv
    }
    return { argv: resolved, platform, home }
  }
  return { error: NO_PYTHON }
}

let installing = false

const lastLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? ''

const join = (home: string, ...rest: string[]) => [home.replace(/[\\/]+$/, ''), ...rest].join('/')

export async function ensureEngine(
  $: EngineCtx,
  py: PythonInfo,
  engine: 'deepgram' | 'whisper',
  root: string,
): Promise<{ python: string } | { error: string }> {
  if (installing) return { error: 'desk-mic is already installing; run /mic again when it finishes.' }
  installing = true
  const stateDir = join(py.home, '.claude-desk-mic')
  const venv = `${stateDir}/venv`
  const stamp = `${venv}/.desk-mic-reqs`
  const lock = `${stateDir}/install.lock`
  const venvPython = py.platform === 'win32' ? `${venv}/Scripts/python.exe` : `${venv}/bin/python`
  const files = [`${root}/engine/requirements.txt`, ...(engine === 'whisper' ? [`${root}/engine/requirements-whisper.txt`] : [])]
  let lockHeld = false
  const run = (argv: string[], timeoutMs?: number) => $.process.run(argv, timeoutMs ? { timeoutMs } : undefined)
  const rmtree = async (path: string) => {
    try {
      await run([...py.argv, '-c', 'import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)', path])
    } catch {
      // best effort
    }
  }
  try {
    let wanted = ''
    try {
      for (const f of files) wanted += `${f.split('/').pop()}\n${await $.fs.read(f)}\n`
    } catch (e) {
      return { error: `desk-mic could not read its requirements files: ${String(e)}` }
    }
    if ((await $.fs.exists(venvPython)) && (await $.fs.exists(stamp))) {
      let have = ''
      try {
        have = await $.fs.read(stamp)
      } catch {
        // an unreadable stamp counts as no stamp
      }
      if (have === wanted) return { python: venvPython }
    }

    // One call makes the state folder and learns the session's pid (the probe's parent).
    let ppid = NaN
    try {
      const r = await run([...py.argv, '-c', 'import os,sys; os.makedirs(sys.argv[1], exist_ok=True); print(os.getppid())', stateDir])
      if (r.exitCode === 0) ppid = parseInt(r.stdout.trim(), 10)
    } catch {
      // handled below
    }
    if (!Number.isInteger(ppid)) return { error: `desk-mic could not prepare ${stateDir} with Python.` }

    if (await $.fs.exists(lock)) {
      const other = parseInt((await $.fs.read(lock).catch(() => '')).trim(), 10)
      if (Number.isInteger(other) && other !== ppid) {
        let alive = false
        try {
          if (py.platform === 'win32') {
            const r = await run(['tasklist', '/FI', `PID eq ${other}`, '/NH'])
            alive = r.stdout.split(/\s+/).includes(String(other))
          } else {
            alive = (await run(['kill', '-0', String(other)])).exitCode === 0
          }
        } catch {
          alive = false
        }
        if (alive) return { error: 'desk-mic is installing in another session; run /mic again when it finishes.' }
      }
    }
    await $.fs.write(lock, String(ppid))
    lockHeld = true

    if (!(await $.fs.exists(venvPython))) {
      let failure = ''
      try {
        const r = await run([...py.argv, '-m', 'venv', venv], TEN_MINUTES)
        if (r.exitCode !== 0) failure = lastLine(r.stderr) || `exit code ${r.exitCode}`
      } catch (e) {
        failure = `timed out or could not start (${String(e)})`
      }
      if (failure) {
        await rmtree(venv)
        return { error: `desk-mic could not create its Python environment (venv step): ${failure}` }
      }
    }

    $.ui.status('mic: installing packages (first run)...')
    for (const f of files) {
      let failure = ''
      try {
        const r = await run([venvPython, '-m', 'pip', 'install', '-r', f], TEN_MINUTES)
        if (r.exitCode !== 0) failure = lastLine(r.stderr) || `exit code ${r.exitCode}`
      } catch (e) {
        failure = `the pip step timed out or could not run (${String(e)})`
      }
      if (failure) {
        let version = 'unknown version'
        try {
          const v = await run([venvPython, '--version'])
          version = (v.stdout || v.stderr).trim() || version
        } catch {
          // keep the placeholder
        }
        return { error: `desk-mic package install failed with ${version} on ${f.split('/').pop()}: ${failure}` }
      }
    }
    await $.fs.write(stamp, wanted)
    return { python: venvPython }
  } finally {
    $.ui.status(undefined)
    if (lockHeld) {
      try {
        await run([...py.argv, '-c', 'import os,sys; os.remove(sys.argv[1])', lock])
      } catch {
        // a stale lock with a dead pid is taken over next time
      }
    }
    installing = false
  }
}
