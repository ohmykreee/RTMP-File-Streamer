import type { Translate, TranslationKey } from '@shared/i18n'
import { translatorFor } from '@shared/i18n'
import { getLanguage } from './store/settings'

/**
 * The main process's view of the active language.
 *
 * The renderer holds the language too (it is the thing that draws the switcher),
 * but the main process produces plenty of text of its own — log lines, ffmpeg
 * diagnostics, dialog titles, the window title — and it must not fall behind the
 * UI: switching to Japanese while the log keeps printing Chinese reads as a bug.
 *
 * There is deliberately no module-level cached translator. `getLanguage()` is
 * backed by the settings store's own cache, so this stays a cheap lookup, and a
 * `setLanguage` call can never leave a stale table behind.
 */
export function t(): Translate<TranslationKey> {
  return translatorFor(getLanguage())
}

/** Shorthand for the common `t()(key, params)` call shape. */
export function mainT(key: TranslationKey, params?: Record<string, string | number>): string {
  return t()(key, params)
}
