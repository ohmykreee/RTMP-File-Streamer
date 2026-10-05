/**
 * Builds the artefacts the verification harnesses need:
 *   .test/builder.bundle.mjs  - command builder for the plain-node harness
 *   .test/probe.bundle.mjs    - ffprobe wrapper for the plain-node harness
 *   .test/i18n.bundle.mjs     - message tables + locale rules for the same harness
 *   .test/rtmp.bundle.mjs     - RTMP target composition for the same harness
 *   out/main/test-entry.cjs   - engine + builder for the Electron integration run
 *
 * (`.test/obs.bundle.mjs` is bundled by harness.mjs itself, next to the checks
 * that use it.)
 *
 * Usage: node .test/build-bundles.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/*
 * esbuild is a transitive dependency (vite and electron-vite both want it) and this
 * repo uses pnpm's isolated linker, so there is no `node_modules/.bin/esbuild` at the
 * root and `require.resolve('esbuild')` fails — the packages live in the store, where
 * the platform binary sits under its own `@esbuild/<platform>` entry.
 *
 * The fallback runs the package's own JS shim under node instead of pnpm's `.cmd`/shell
 * wrapper: that keeps everything shell-free, and the wrapper is a `.cmd` on Windows,
 * which needs `shell: true` and makes node print a deprecation warning. With the shim
 * the same `spawnSync` call works on every platform.
 */
const esbuildPlatform = `${process.platform}-${process.arch}`
const esbuildBinary = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'
const esbuildStore = path.join(root, 'node_modules', '.pnpm')
const esbuildExe = fs
  .readdirSync(esbuildStore)
  .filter((entry) => entry.startsWith(`@esbuild+${esbuildPlatform}@`))
  .sort()
  .map((entry) => path.join(esbuildStore, entry, 'node_modules', '@esbuild', esbuildPlatform, esbuildBinary))
  .find((candidate) => fs.existsSync(candidate))
const esbuildShim = esbuildExe
  ? null
  : fs
      .readdirSync(esbuildStore)
      .filter((entry) => entry.startsWith('esbuild@'))
      .sort()
      .map((entry) => path.join(esbuildStore, entry, 'node_modules', 'esbuild', 'bin', 'esbuild'))
      .find((candidate) => fs.existsSync(candidate))

if (!esbuildExe && !esbuildShim) {
  console.error(
    `esbuild not found: no @esbuild/${esbuildPlatform} package in node_modules/.pnpm.\n` +
      `Run \`pnpm install\` (a plain one — \`pnpm-workspace.yaml\` allowlists the build scripts).`
  )
  process.exit(1)
}
const esbuild = esbuildExe ?? process.execPath
const esbuildArgs = (cliArgs) => (esbuildExe ? cliArgs : [esbuildShim, ...cliArgs])

const targets = [
  {
    // Shared RTMP target composition, exercised directly by the harness.
    entry: 'src/shared/rtmp.ts',
    out: '.test/rtmp.bundle.mjs',
    format: 'esm',
    platform: 'node'
  },
  {
    entry: 'src/main/ffmpeg/command.ts',
    out: '.test/builder.bundle.mjs',
    format: 'esm',
    platform: 'node'
  },
  {
    entry: 'src/main/ffmpeg/probe.ts',
    out: '.test/probe.bundle.mjs',
    format: 'esm',
    platform: 'node'
  },
  {
    // Message tables + locale rules, so the harness can assert that every language
    // defines every key and that the detection rules match the documented ones.
    entry: 'src/shared/i18n/index.ts',
    out: '.test/i18n.bundle.mjs',
    format: 'esm',
    platform: 'node'
  },
  {
    entry: 'src/main/test-entry.ts',
    out: 'out/main/test-entry.cjs',
    format: 'cjs',
    platform: 'node',
    external: ['electron']
  }
]

for (const t of targets) {
  const args = [
    t.entry,
    '--bundle',
    `--platform=${t.platform}`,
    `--format=${t.format}`,
    `--outfile=${t.out}`,
    '--alias:@shared=./src/shared',
    '--alias:@main=./src/main',
    '--log-level=warning'
  ]
  for (const e of t.external ?? []) args.push(`--external:${e}`)

  const res = spawnSync(esbuild, esbuildArgs(args), { cwd: root, encoding: 'utf8' })
  if (res.status !== 0) {
    console.error(`build failed for ${t.entry}:\n${res.stderr || res.stdout}`)
    process.exit(1)
  }
  const size = fs.existsSync(path.join(root, t.out)) ? fs.statSync(path.join(root, t.out)).size : 0
  console.log(`  ${t.out.padEnd(28)} ${(size / 1024).toFixed(1)} KB`)
}
console.log('bundles ready')
