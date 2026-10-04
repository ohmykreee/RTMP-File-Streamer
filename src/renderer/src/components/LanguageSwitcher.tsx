import { useEffect, useRef, useState } from 'react'
import type { Language } from '@shared/types'
import { LANGUAGES, LANGUAGE_BADGE, LANGUAGE_NATIVE_NAME } from '@shared/i18n'
import { useT } from '../i18n'

interface LanguageSwitcherProps {
  /** The language in force. */
  language: Language
  /** True while a session runs: the switcher is frozen with every other control. */
  locked?: boolean
  onSelect: (language: Language) => void
}

/**
 * Language picker.
 *
 * Sits at the far right of the top bar, after the status pills, so switching the
 * interface language is always reachable without opening a settings tab.
 *
 * The menu lists every language under its own name and script (中文 / 日本語 /
 * English) instead of a translation of it: a picker that writes "Japanese" in a
 * language the user cannot read is no picker at all. `LANGUAGE_NATIVE_NAME` and
 * `LANGUAGE_BADGE` therefore come from the i18n core rather than the message
 * table — they are the same three strings in every language, by design.
 */
export default function LanguageSwitcher({ language, locked, onSelect }: LanguageSwitcherProps): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  /* Close on outside click / Escape: a popup menu that can only be dismissed by
     picking something is a trap, and this one covers part of the status row. */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="lang-switch" ref={rootRef}>
      <button
        type="button"
        className="lang-btn"
        disabled={locked}
        aria-haspopup="menu"
        aria-expanded={open}
        title={locked ? t('app.langLocked') : t('app.languageSwitch', { name: LANGUAGE_NATIVE_NAME[language] })}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="lang-globe" aria-hidden>
          🌐
        </span>
        <span className="lang-badge">{LANGUAGE_BADGE[language]}</span>
        <span className="lang-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="lang-menu" role="menu">
          <div className="lang-menu-head">{t('app.language')}</div>
          {LANGUAGES.map((code) => (
            <button
              key={code}
              type="button"
              role="menuitemradio"
              aria-checked={code === language}
              /* The badge and the name are separate inline elements; without an
                 explicit label the accessible name runs them together ("中中文"). */
              aria-label={`${LANGUAGE_NATIVE_NAME[code]}${code === language ? ` (${t('app.languageCurrent')})` : ''}`}
              className={`lang-item${code === language ? ' active' : ''}`}
              onClick={() => {
                setOpen(false)
                if (code !== language) onSelect(code)
              }}
            >
              <span className="lang-item-badge" aria-hidden>
                {LANGUAGE_BADGE[code]}
              </span>
              {LANGUAGE_NATIVE_NAME[code]}
              {code === language && (
                <span className="lang-item-check" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
