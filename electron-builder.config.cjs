/**
 * electron-builder configuration.
 *
 * FFmpeg is deliberately NOT bundled: it is GPL-licensed and the app discovers
 * the user's own install automatically. To ship a copy anyway, put
 * `ffmpeg.exe`/`ffprobe.exe` into a `bin/` folder next to the project — the
 * `extraResources` entry below then copies it into `resources/bin`, which the
 * resolver prefers over PATH.
 */
module.exports = {
  appId: 'net.kre3.rtmpfilestreamer',
  productName: 'RTMP File Streamer',
  copyright: 'Copyright © 2026 TurboKre',
  directories: {
    output: 'release',
    buildResources: 'build'
  },
  files: [
    'out/**/*',
    'package.json',
    // Build identity written by scripts/build-info.mjs (version/commit/nightly);
    // read back at runtime by src/main/buildInfo.ts for the About panel.
    'build-info.json',
    '!**/*.map',
    '!node_modules/**/*'
  ],
  extraResources: [
    {
      from: 'bin',
      to: 'bin',
      filter: ['**/*']
    },
    {
      // Ship an empty Data folder so the portable layout is self-documenting:
      // this is where settings.json, playlist.json, presets.json and Cache/ are
      // written at runtime (see src/main/store/paths.ts).
      from: 'build/data-placeholder',
      to: '../Data',
      filter: ['**/*']
    }
  ],
  asar: true,
  win: {
    // Unpacked directory build only — no portable single-file exe. The result is
    // release/win-unpacked/, which is a self-contained folder: application state
    // is written to its own Data/ directory, so the whole folder can be moved or
    // copied anywhere and keeps working.
    target: ['dir'],
    icon: 'build/icon.ico',
    executableName: 'RTMPFileStreamer',
    requestedExecutionLevel: 'asInvoker'
  },
  linux: {
    target: ['dir'],
    category: 'AudioVideo',
    icon: 'build/icon.png'
  },
  mac: {
    target: ['dir'],
    category: 'public.app-category.video',
    icon: 'build/icon.png'
  }
}
