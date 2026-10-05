/**
 * Locates the esbuild executable for the CURRENT platform.
 *
 * esbuild is a transitive dependency (vite pulls it in), and this repo uses pnpm's
 * isolated linker, so the old "look for @esbuild/win32-x64/esbuild.exe" lookup only
 * ever worked on a Windows dev box — on a Linux runner it found nothing and the whole
 * non-Electron suite died at the bundling stage. The checks now also run on Linux in
 * CI, so the lookup has to name the right package for whatever platform it runs on.
 *
 * Search order, first hit wins:
 *   1. node_modules/.pnpm/@esbuild/<platform>-<arch>@<version>/…  the native binary
 *   2. node_modules/@esbuild/<platform>-<arch>/…                 if someone hoists it
 *   3. node_modules/esbuild/bin/esbuild                          the JS shim (needs node)
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/** esbuild's own name for this platform/arch, e.g. `linux-x64` or `win32-x64`. */
function platformPackage() {
  return `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`
}

/** The executable inside an `@esbuild/<platform>` package. */
function binaryName() {
  return process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'
}

/** `node_modules/.pnpm/@esbuild+linux-x64@0.25.12/node_modules/@esbuild/linux-x64/esbuild` */
function fromPnpmStore() {
  const store = path.join(root, 'node_modules', '.pnpm')
  if (!fs.existsSync(store)) return null
  const prefix = `@esbuild+${platformPackage()}@`
  const dirs = fs
    .readdirSync(store)
    .filter((d) => d.startsWith(prefix))
    // Newest version first: several esbuild copies can sit in the store at once
    // (vite and electron-builder do not have to agree on a version).
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const dir of dirs) {
    const candidate = path.join(store, dir, 'node_modules', '@esbuild', platformPackage(), binaryName())
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** `node_modules/@esbuild/linux-x64/esbuild` */
function fromHoisted() {
  const candidate = path.join(root, 'node_modules', '@esbuild', platformPackage(), binaryName())
  return fs.existsSync(candidate) ? candidate : null
}

/** `node_modules/esbuild/bin/esbuild` — a JS shim that has to run under node. */
function fromLauncher() {
  try {
    const require = createRequire(path.join(root, 'package.json'))
    const resolved = require.resolve('esbuild/bin/esbuild')
    return fs.existsSync(resolved) ? resolved : null
  } catch {
    return null
  }
}

/**
 * How to run the esbuild CLI.
 *
 * The two shapes differ: the native binaries ARE the CLI, while `bin/esbuild` is a
 * JavaScript shim that only works when node runs it — and it is also called
 * `esbuild`, so the name cannot be used to tell them apart.
 *
 * @returns {{ command: string, args: (cliArgs: string[]) => string[] } | null}
 */
export function esbuildCommand() {
  const native = fromPnpmStore() ?? fromHoisted()
  if (native) return { command: native, args: (cliArgs) => cliArgs }

  const shim = fromLauncher()
  if (shim) return { command: process.execPath, args: (cliArgs) => [shim, ...cliArgs] }

  return null
}
