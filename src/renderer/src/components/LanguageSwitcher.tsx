import type { Language } from '@shared/types'
import { LANGUAGES, LANGUAGE_BADGE, LANGUAGE_NATIVE_NAME } from '@shared/i18n'
import { ChevronDown, Globe } from 'lucide-react'
import { cn } from 'cn'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
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
 * interface language is always reachable without opening a settings tab. It reads
 * as one more chip in that row rather than as a button, because that is what it
 * is: a display setting, not a transport control.
 *
 * The menu lists every language under its own name and script (中文 / 日本語 /
 * English) instead of a translation of it: a picker that writes "Japanese" in a
 * language the user cannot read is no picker at all. `LANGUAGE_NATIVE_NAME` and
 * `LANGUAGE_BADGE` therefore come from the i18n core rather than the message
 * table — they are the same three strings in every language, by design.
 *
 * The selected entry stays selected: this is a radio group dressed as a menu, so
 * re-picking the active language is a no-op rather than a deselect.
 */
export default function LanguageSwitcher({ language, locked, onSelect }: LanguageSwitcherProps): React.JSX.Element {
  const t = useT()

  return (
    // The wrapper is what makes the control the last child of the status row: the
    // menu primitive renders no element of its own, so without it the trigger
    // button itself would become that child and shift when the row grows.
    <div className="lang-switch">
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={locked}
          className={cn(
            'lang-btn inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-card/60 px-2 text-[11.5px]',
            'text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground',
            'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50'
          )}
          title={locked ? t('app.langLocked') : t('app.languageSwitch', { name: LANGUAGE_NATIVE_NAME[language] })}
        >
          <Globe className="lang-globe size-3.5" aria-hidden />
          <span className="lang-badge">{LANGUAGE_BADGE[language]}</span>
          <ChevronDown className="size-3 opacity-70" aria-hidden />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="lang-menu">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="lang-menu-head text-[11px] text-muted-foreground">{t('app.language')}</DropdownMenuLabel>
            {LANGUAGES.map((code) => (
              <DropdownMenuCheckboxItem
                key={code}
                checked={code === language}
                /* Menu checkbox items keep the menu open by default (they are built
                   for toggling several options); this one picks exactly one, so the
                   click has to dismiss it. */
                closeOnClick
                /* The badge and the name are separate inline elements; without an
                   explicit label the accessible name runs them together ("中中文"). */
                aria-label={`${LANGUAGE_NATIVE_NAME[code]}${code === language ? ` (${t('app.languageCurrent')})` : ''}`}
                className={cn('lang-item text-[12.5px]', code === language && 'active')}
                onCheckedChange={() => {
                  if (code !== language) onSelect(code)
                }}
              >
                <span className="lang-item-badge" aria-hidden>
                  {LANGUAGE_BADGE[code]}
                </span>
                {LANGUAGE_NATIVE_NAME[code]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
