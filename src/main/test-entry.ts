/**
 * Test-only entry point. Bundled to out/main/test-entry.cjs so the integration
 * harness can drive the real StreamEngine and command builder inside Electron
 * without booting the UI.
 */
export { StreamEngine } from './stream/engine'
export { buildStreamCommand, buildTestCommand, buildCommandLine } from './ffmpeg/command'
export { probeMedia, embeddedSubtitleRefs, probeSubtitleFile, classifySubtitle } from './ffmpeg/probe'
export { getCapabilities, resolveBinaries, runProcess, ENCODER_CATALOGUE } from './ffmpeg/capabilities'
