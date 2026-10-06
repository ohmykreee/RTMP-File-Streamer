/**
 * Builds the artefacts the verification harnesses need:
 *   test/builder.bundle.mjs  - command builder for the plain-node harness
 *   test/probe.bundle.mjs    - ffprobe wrapper for the plain-node harness
 *   test/i18n.bundle.mjs     - message tables + locale rules for the same harness
 *   test/rtmp.bundle.mjs     - RTMP target composition for the same harness
 *   out/main/test-entry.cjs   - engine + builder for the Electron integration run
 *
 * (`test/obs.bundle.mjs` is bundled by harness.mjs itself, next to the checks
 * that use it.)
 *
 * Usage: node test/build-bundles.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/*
 * Bundling goes through esbuild's JavaScript API rather than its CLI, and esbuild is a
 * declared devDependency rather than whatever version happens to arrive transitively.
 *
 * Both of those are load-bearing. Looking for the CLI meant working out where pnpm's
 * isolated store hid the binary and what format it had there — and that format is a
 * native ELF binary on Linux but a POSIX `/bin/sh` script on Windows, so a lookup that
 * "found" it could still be wrong about how to run it (CI died handing an ELF header to
 * node). The API has none of that: it resolves its own platform binary, and the CI log
 * shows the missing piece was that binary — `pnpm ci` installs the esbuild package and
 * runs its postinstall, which is what puts it in place.
 */
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

/** Every alias the app's own bundler resolves, since the modules under test import them. */
const alias = { '@shared': './src/shared', '@main': './src/main' }

const targets = [
  {
    // Shared RTMP target composition, exercised directly by the harness.
    entry: 'src/shared/rtmp.ts',
    out: 'test/rtmp.bundle.mjs',
    format: 'esm'
  },
  {
    // Stream protocol detection / target composition, exercised directly by the harness.
    entry: 'src/shared/protocol.ts',
    out: 'test/protocol.bundle.mjs',
    format: 'esm'
  },
  {
    entry: 'src/main/ffmpeg/command.ts',
    out: 'test/builder.bundle.mjs',
    format: 'esm'
  },
  {
    entry: 'src/main/ffmpeg/probe.ts',
    out: 'test/probe.bundle.mjs',
    format: 'esm'
  },
  {
    // Message tables + locale rules, so the harness can assert that every language
    // defines every key and that the detection rules match the documented ones.
    entry: 'src/shared/i18n/index.ts',
    out: 'test/i18n.bundle.mjs',
    format: 'esm'
  },
  {
    entry: 'src/main/test-entry.ts',
    out: 'out/main/test-entry.cjs',
    format: 'cjs',
    external: ['electron']
  }
]

for (const t of targets) {
  try {
    esbuild.buildSync({
      entryPoints: [t.entry],
      outfile: t.out,
      bundle: true,
      platform: 'node',
      format: t.format,
      alias,
      external: t.external ?? [],
      logLevel: 'warning'
    })
  } catch (err) {
    // esbuild already printed the offending line and its source position.
    console.error(`build failed for ${t.entry}`)
    process.exit(1)
  }
  const size = fs.existsSync(path.join(root, t.out)) ? fs.statSync(path.join(root, t.out)).size : 0
  console.log(`  ${t.out.padEnd(28)} ${(size / 1024).toFixed(1)} KB`)
}
console.log('bundles ready')
