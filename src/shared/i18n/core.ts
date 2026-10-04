/**
 * Internationalization core (language identity, system detection, lookup).
 *
 * The translated text itself lives in `./messages` — this module only decides
 * *which* language to use and how a key is resolved. Keeping the two apart means
 * the lookup machinery is dependency-free (it is compiled into the main process,
 * the preload script and the renderer alike) and the message tables stay a plain
 * data file that can be edited without touching logic.
 */

/** The languages the UI ships with. */
export type Language = 'zh' | 'ja' | 'en'

/** Every language, in the order the switcher lists them. */
export const LANGUAGES: Language[] = ['zh', 'ja', 'en']

/**
 * Native names of the languages, used by the language switcher itself.
 *
 * Deliberately NOT translated: a language picker that renders each option in the
 * language you are currently stuck in is useless to the person who cannot read
 * it. "日本語" is what a Japanese speaker looks for regardless of the current UI.
 */
export const LANGUAGE_NATIVE_NAME: Record<Language, string> = {
  zh: '中文',
  ja: '日本語',
  en: 'English'
}

/** Short badge text for the switcher button. */
export const LANGUAGE_BADGE: Record<Language, string> = {
  zh: '中',
  ja: 'あ',
  en: 'EN'
}

/** Language used when nothing matches — and the base table every key must exist in. */
export const FALLBACK_LANGUAGE: Language = 'en'

/**
 * Narrowing test for persisted / incoming values.
 *
 * Anything else (an older file, a hand-edited settings.json, a locale string that
 * slipped through) is rejected rather than coerced, so a bad value falls back to
 * detection instead of leaving the app with a language it cannot render.
 */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

/** True for every Chinese variant a locale tag can carry. */
function isChineseTag(tag: string): boolean {
  return /^zh(?:[-_]|$)/i.test(tag) || /^(?:chi|zho|chs|cht|hans|hant|cmn|yue)(?:[-_]|$)/i.test(tag)
}

/**
 * True for Traditional Chinese, as opposed to Simplified.
 *
 * Region and script subtags both count: `zh-TW`, `zh-HK`, `zh-MO` and `zh-Hant`
 * are Traditional, while `zh-CN`, `zh-SG`, `zh-Hans` and a bare `zh` are
 * Simplified.
 */
export function isTraditionalChinese(tag: string): boolean {
  return /hant/i.test(tag) || /^zh[-_](?:tw|hk|mo)(?:[-_]|$)/i.test(tag)
}

/**
 * Picks the UI language for a system locale tag.
 *
 * The rules, in order:
 *  - Chinese, any variant → Chinese. A Traditional-Chinese system gets the same
 *    table: the app ships one Chinese translation, and Simplified is the script
 *    those users read alongside Traditional.
 *  - Japanese → Japanese.
 *  - everything else → English.
 */
export function detectLanguage(systemLocale?: string | null): Language {
  const tag = String(systemLocale ?? '').trim()
  if (!tag) return FALLBACK_LANGUAGE
  if (isChineseTag(tag)) return 'zh'
  if (/^ja(?:[-_]|$)/i.test(tag)) return 'ja'
  return FALLBACK_LANGUAGE
}

/**
 * The language to run with: the saved one when it is valid, otherwise whatever
 * the system asks for. This is the single place the "no saved language yet" rule
 * is expressed, so first launch, a corrupted settings file and a settings file
 * written by an older version all take the same path.
 */
export function resolveLanguage(stored: unknown, systemLocale?: string | null): Language {
  return isLanguage(stored) ? stored : detectLanguage(systemLocale)
}

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

/** A parameterized message is stored with `{name}` holes, e.g. `已添加 {n} 个文件`. */
export type MessageParams = Record<string, string | number>

/** One language's message table. */
export type Catalog<Key extends string = string> = Record<Key, string>

/**
 * How a message is looked up. Both processes build one of these and hand it to
 * whatever needs to render text, so no module has to know the active language.
 */
export type Translate<Key extends string = string> = (key: Key, params?: MessageParams) => string

/**
 * Copy of `base` with one language's overrides applied.
 *
 * Used to assemble the run-time table: the reference language supplies every key,
 * so a key missing from a translation renders as the reference text instead of
 * being visible as a raw key. `assertCatalogsComplete` is what keeps that safety
 * net from quietly becoming the normal case.
 */
export function mergeCatalog<Key extends string>(base: Catalog<Key>, overrides: Partial<Catalog<Key>>): Catalog<Key> {
  return { ...base, ...overrides }
}

/** Fills `{name}` holes. Unknown placeholders are left untouched for diagnosis. */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined || value === null ? whole : String(value)
  })
}

/**
 * Builds the lookup function for one language.
 *
 * Fallback chain: the requested table → the key itself. The second step only ever
 * happens for a key that does not exist in the table handed in, which
 * `assertCatalogsComplete` turns into a startup-time report.
 */
export function createT<Key extends string>(catalog: Catalog<Key>): Translate<Key> {
  return (key, params) => interpolate(catalog[key] ?? key, params)
}

/* ------------------------------------------------------------------ *
 * Completeness check
 * ------------------------------------------------------------------ */

/**
 * Reports keys a translation is missing, or defines without the reference having
 * them.
 *
 * Called at startup and from the test suite rather than trusted blindly: a missing
 * translation is otherwise invisible — the UI simply renders the reference
 * language in one spot, which reads as a styling glitch rather than a bug. It
 * returns the problems instead of throwing so the app can log them and carry on
 * with the fallback text rather than refusing to start.
 */
export function assertCatalogsComplete<Key extends string>(
  reference: Catalog<Key>,
  others: Partial<Record<Language, Partial<Catalog<Key>>>>
): string[] {
  const problems: string[] = []
  const referenceKeys = Object.keys(reference) as Key[]
  for (const [language, catalog] of Object.entries(others)) {
    if (!catalog) continue
    for (const key of referenceKeys) {
      if (typeof catalog[key] !== 'string') problems.push(`${language}: missing key "${key}"`)
    }
    for (const key of Object.keys(catalog)) {
      if (!(key in reference)) problems.push(`${language}: unknown key "${key}" (not in the reference table)`)
    }
  }
  return problems
}
