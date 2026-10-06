import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * Build identity, written by `scripts/build-info.mjs` at build time into
 * `build-info.json` next to `package.json` (gitignored; packaged into the asar
 * via the `files` list in `electron-builder.config.cjs`).
 *
 * `app.getVersion()` reads package.json, which describes the NEXT release between
 * tagging and publishing; the build-info file freezes the version the build was
 * actually made from, along with the exact commit and whether that commit carried
 * a tag (untagged builds are nightlies).
 */
export interface BuildInfo {
  version: string
  /** First 10 characters of the commit the build was made from. */
  commit: string
  /** True when the built commit carries no git tag. */
  nightly: boolean
  /** ISO timestamp of the build. */
  builtAt: string
}

export function readBuildInfo(): BuildInfo | null {
  try {
    // appPath is the asar root when packaged and the project root in development —
    // the same relative spot in both, which is where the build script writes it.
    const raw = fs.readFileSync(path.join(app.getAppPath(), 'build-info.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<BuildInfo>
    if (typeof parsed?.version !== 'string' || !parsed.version) return null
    return {
      version: parsed.version,
      commit: typeof parsed.commit === 'string' ? parsed.commit : '',
      nightly: parsed.nightly !== false,
      builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : ''
    }
  } catch {
    // No file (a dev run without a prior build) or an unreadable one: the caller
    // falls back to package.json's version.
    return null
  }
}
