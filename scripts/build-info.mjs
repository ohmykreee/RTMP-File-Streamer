/**
 * Writes `build-info.json` — the build's identity, for the About panel.
 *
 * Runs before every compile (`pnpm build` / `pnpm dist` / `pnpm dev`): it freezes
 * the version package.json carried at build time, the first 10 characters of the
 * commit the build was made from, whether that commit carries a git tag
 * (tagged = release, untagged = nightly) and the build time. The main process
 * reads the file back (`src/main/buildInfo.ts`) instead of `app.getVersion()`,
 * which between tagging and publishing describes the NEXT release rather than
 * this build.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

/** Runs a git command, returning '' instead of throwing when git is unavailable. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const commitFull = git(['rev-parse', 'HEAD'])
const commit = commitFull ? commitFull.slice(0, 10) : ''

// A build is a release build only when the exact commit it was made from is
// tagged; everything else — a dirty tree, CI, a dev build — is a nightly. This
// reads the tags ON the checked-out commit only, which is why it also works on
// CI's shallow clone of a tagged ref: comparing the whole tag LIST against
// package.json is what is not possible there.
const tagsOnHead = git(['tag', '--points-at', 'HEAD'])
const nightly = tagsOnHead === ''

const info = {
  version: pkg.version,
  commit,
  nightly,
  builtAt: new Date().toISOString()
}

writeFileSync(path.join(root, 'build-info.json'), JSON.stringify(info, null, 2) + '\n', 'utf8')
console.log(
  `[build-info] v${info.version} commit=${commit || '(none)'} ${nightly ? 'nightly' : 'release'} at ${info.builtAt}`
)
