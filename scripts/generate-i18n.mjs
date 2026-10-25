// Generates the JSON the Rust side embeds at compile time, from the TypeScript
// source of truth:
//   src/shared/i18n/messages.ts  -> src-tauri/resources/i18n/{en,zh,ja}.json
//   src/shared/defaults.ts       -> src-tauri/resources/i18n/defaults.json
//
// The renderer compiles messages.ts / defaults.ts directly; the Rust port embeds
// these dumps instead of hand-copying the values, so the two sides cannot drift.
// Catalog consistency (three tables, same keys) is asserted by `pnpm test:unit`
// and again by a cargo test over the generated files.
import { buildSync } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.join(root, 'src-tauri', 'resources', 'i18n')
const nodeRequire = createRequire(import.meta.url)

// Bundle the TS data file into CJS, import it once, delete the bundle. The
// tables are plain data with no dependencies; using esbuild rather than parsing
// the sources keeps this generator blind to their internal structure.
function bundleTs(entry) {
  const cacheDir = path.join(root, 'node_modules', '.cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  const outfile = path.join(cacheDir, `gen-${Math.random().toString(36).slice(2)}.cjs`)
  buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
  })
  const mod = nodeRequire(outfile)
  fs.rmSync(outfile, { force: true })
  return mod.default ?? mod
}

fs.mkdirSync(outDir, { recursive: true })

const { EN, ZH, JA } = bundleTs(path.join(root, 'src/shared/i18n/messages.ts'))
for (const [lang, table] of [['en', EN], ['zh', ZH], ['ja', JA]]) {
  fs.writeFileSync(path.join(outDir, `${lang}.json`), JSON.stringify(table, null, 2) + '\n', 'utf8')
}

const defs = bundleTs(path.join(root, 'src/shared/defaults.ts'))
fs.writeFileSync(
  path.join(outDir, 'defaults.json'),
  JSON.stringify({ DEFAULT_SETTINGS: defs.DEFAULT_SETTINGS, BUILTIN_PRESETS: defs.BUILTIN_PRESETS }, null, 2) + '\n',
  'utf8'
)

console.log(`[generate-shared] EN=${Object.keys(EN).length} ZH=${Object.keys(ZH).length} JA=${Object.keys(JA).length} keys; ${defs.BUILTIN_PRESETS.length} builtin presets -> src-tauri/resources/i18n/`)
