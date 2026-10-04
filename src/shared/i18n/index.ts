/**
 * i18n entry point.
 *
 * Import from here rather than from the two files directly:
 *
 *   import { resolveLanguage, createT, TRANSLATIONS, type Language } from '@shared/i18n'
 */
export {
  LANGUAGES,
  LANGUAGE_NATIVE_NAME,
  LANGUAGE_BADGE,
  FALLBACK_LANGUAGE,
  isLanguage,
  isTraditionalChinese,
  detectLanguage,
  resolveLanguage,
  mergeCatalog,
  interpolate,
  createT,
  assertCatalogsComplete
} from './core'
export type { Language, Catalog, Translate, MessageParams } from './core'

export { EN, ZH, JA, REFERENCE_CATALOG, TRANSLATIONS } from './messages'
export type { TranslationKey } from './messages'

import type { Catalog, Language, Translate } from './core'
import { createT } from './core'
import { TRANSLATIONS, type TranslationKey } from './messages'

/**
 * The message table for one language.
 *
 * Typed rather than inferred on purpose: `TRANSLATIONS` is assembled by spreading
 * the per-language tables over the reference, which widens their literal key sets.
 * `Catalog<TranslationKey>` holds every table to the same key set, so a table that
 * drifts is a type error here and not just at run time.
 */
export function messagesFor(language: Language): Catalog<TranslationKey> {
  return TRANSLATIONS[language] as Catalog<TranslationKey>
}

/** Shorthand for `createT(messagesFor(language))`. */
export function translatorFor(language: Language): Translate<TranslationKey> {
  return createT(messagesFor(language))
}
