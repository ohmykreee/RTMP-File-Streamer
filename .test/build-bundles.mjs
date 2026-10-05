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
import { esbuildCommand } from './find-esbuild.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/* esbuild ships a native binary per platform; `.test/find-esbuild.mjs` knows where
 * pnpm's isolated store keeps the one for the machine this is running on. */
const esbuild = esbuildCommand()
if (!esbuild) {
  console.error('esbuild not found; run `pnpm install` first')
  process.exit(1)
}

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

  const res = spawnSync(esbuild.command, esbuild.args(args), { cwd: root, encoding: 'utf8' })
  if (res.status !== 0) {
    console.error(`build failed for ${t.entry}:\n${res.stderr || res.stdout}`)
    process.exit(1)
  }
  const size = fs.existsSync(path.join(root, t.out)) ? fs.statSync(path.join(root, t.out)).size : 0
  console.log(`  ${t.out.padEnd(28)} ${(size / 1024).toFixed(1)} KB`)
}
console.log('bundles ready')
