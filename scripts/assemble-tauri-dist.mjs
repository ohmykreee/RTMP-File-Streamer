// Assembles the portable distribution directory after `cargo build --release`
// (see .github/workflows/build.yml) or `tauri build --no-bundle`
// (`pnpm run build:tauri`). Replicates the electron-builder `--dir` layout the
// project has always shipped: the executable, a `Data/` placeholder next to it
// (the app writes all of its state there), and the optional `bin/` drop-in for
// a bundled ffmpeg.
//
//   node scripts/assemble-tauri-dist.mjs [--target <triple>]
//
// Output: release/rtmp-file-streamer-<platform>-<arch>/.
//
// The platform and architecture come from `--target`, NOT from the host: CI
// cross-builds the Windows and ARM64 binaries on Ubuntu, so `process.platform`
// there would look for a Linux binary and label the folder `linux-x64`. Without
// `--target` the host's own `target/release` is used (local `pnpm dist:tauri`).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const targetIdx = args.indexOf('--target')
if (targetIdx >= 0 && !args[targetIdx + 1]) {
  console.error('[assemble] --target needs a Rust target triple')
  process.exit(1)
}
const target = targetIdx >= 0 ? args[targetIdx + 1] : null

// Published folder names are the historical `platform-arch` spellings:
// `win-amd64` / `linux-arm64` / `mac-intel`, with the Apple-silicon build
// keeping the bare `mac` name. Keep this in sync with the CI matrices.
function describe(triple) {
  const platform = triple.includes('windows')
    ? 'win'
    : triple.includes('apple-darwin')
      ? 'mac'
      : triple.includes('linux')
        ? 'linux'
        : null
  if (!platform) {
    throw new Error(`[assemble] cannot tell the target platform from "${triple}"`)
  }

  const arch = triple.startsWith('x86_64') || triple.startsWith('amd64')
    ? 'amd64'
    : triple.startsWith('aarch64') || triple.startsWith('arm64')
      ? 'arm64'
      : triple.startsWith('i686') || triple.startsWith('i586')
        ? 'x86'
        : null
  if (!arch) {
    throw new Error(`[assemble] cannot tell the target architecture from "${triple}"`)
  }

  const label = platform === 'mac' ? (arch === 'amd64' ? 'mac-intel' : 'mac') : `${platform}-${arch}`
  return { platform, arch, label }
}

function hostTriple() {
  const os =
    process.platform === 'win32' ? 'pc-windows-msvc' : process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'
  const cpu =
    process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch === 'ia32' ? 'i686' : process.arch
  return `${cpu}-${os}`
}

const host = hostTriple()
const { platform, label } = describe(target ?? host)
const distName = `rtmp-file-streamer-${label}`
const distDir = path.join(root, 'release', distName)

// Locate the built binary. When --target is given only that target's release
// directory counts: falling back to the host's `target/release` would package a
// host binary under a cross-build name if the cross build failed. Without
// --target either layout is accepted, because `tauri build` writes to
// `target/release` and a plain `cargo build --target <host>` to the triple dir.
const baseTarget = path.join(root, 'src-tauri', 'target')
const candidates = target
  ? [path.join(baseTarget, target, 'release')]
  : [path.join(baseTarget, 'release'), path.join(baseTarget, host, 'release')]

// `cargo build` leaves the package name; `tauri build` renames it to
// mainBinaryName (RTMPFileStreamer). Accept both, with the target's extension.
const ext = platform === 'win' ? '.exe' : ''
const exeNames = [`rtmp-file-streamer${ext}`, `RTMPFileStreamer${ext}`]
let exePath = null
outer: for (const dir of candidates) {
  for (const name of exeNames) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) {
      exePath = candidate
      break outer
    }
  }
}
if (!exePath) {
  console.error(`[assemble] built binary not found in ${candidates.join(', ')}`)
  console.error('[assemble] run `pnpm run build:tauri` first')
  process.exit(1)
}

const shippedName = platform === 'win' ? 'RTMPFileStreamer.exe' : platform === 'mac' ? 'RTMPFileStreamer' : 'rtmp-file-streamer'

fs.rmSync(distDir, { recursive: true, force: true })
fs.mkdirSync(distDir, { recursive: true })
fs.copyFileSync(exePath, path.join(distDir, shippedName))

// The build identity file sits next to the executable; the app reads it for
// the About panel (version/commit/nightly/builtAt).
const buildInfo = path.join(root, 'build-info.json')
if (fs.existsSync(buildInfo)) {
  fs.copyFileSync(buildInfo, path.join(distDir, 'build-info.json'))
}

// The Data placeholder documents the portable layout; the app creates its own
// files inside on first run.
const placeholder = path.join(root, 'build', 'data-placeholder')
if (fs.existsSync(placeholder)) {
  fs.cpSync(placeholder, path.join(distDir, 'Data'), { recursive: true })
}

// Optional user-supplied ffmpeg drop-in (kept out of the repo, shipped when present).
const binDir = path.join(root, 'bin')
const binReadme = path.join(binDir, 'README.txt')
if (fs.existsSync(binDir)) {
  fs.cpSync(binDir, path.join(distDir, 'bin'), { recursive: true })
  // The README alone does not count as "a bundled ffmpeg": drop it if the
  // folder only carries documentation.
  const hasBinaries = fs
    .readdirSync(binDir)
    .some((f) => /\.(exe|dll|so|dylib)$/i.test(f) || (!f.endsWith('.txt') && fs.statSync(path.join(binDir, f)).isFile()))
  if (!hasBinaries && fs.existsSync(binReadme)) {
    // keep README.txt, nothing else to do
  }
}

console.log(`[assemble] ${distName} -> ${distDir}`)
console.log(`[assemble] binary: ${path.join(distDir, shippedName)}`)
