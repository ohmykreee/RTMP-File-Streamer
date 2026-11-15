import { createContext, useContext } from 'react'
import type { Language, MessageParams, TranslationKey } from '@shared/i18n'

/**
 * The renderer's translation function.
 *
 * Components take this as a prop rather than reaching for a global: the language
 * is state, and a component that renders text from a prop re-renders when that
 * prop changes, which is exactly the behaviour a language switch needs. The
 * context below exists for the few places that would otherwise have to thread it
 * through several layers of markup.
 */
export type T = (key: TranslationKey, params?: MessageParams) => string

/**
 * Provides `t` to the component tree.
 *
 * A non-null default is deliberately avoided: a component that reads this without
 * a provider is a wiring bug, and `useT` throws with a message that says so
 * instead of rendering raw keys.
 */
export const I18nContext = createContext<T | null>(null)

/** Reads the translation function from the surrounding provider. */
export function useT(): T {
  const t = useContext(I18nContext)
  if (!t) throw new Error('useT() must be used inside <I18nContext.Provider>')
  return t
}

/** The active language, for the switcher itself and for `<html lang>`. */
export const LanguageContext = createContext<Language>('en')

export function useLanguage(): Language {
  return useContext(LanguageContext)
}
