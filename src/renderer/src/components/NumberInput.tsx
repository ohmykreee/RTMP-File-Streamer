import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'

type InputProps = React.ComponentProps<typeof Input>

/**
 * A number field that keeps what you type.
 *
 * Committing on every keystroke makes the model answer back in the middle of an
 * edit: the field is emptied for a moment, that empty string becomes `0` (or the
 * clamp floor of whatever setting it feeds), and the figure the user was about to
 * retype is replaced by it. This holds a draft while the field has focus and hands
 * the number over when it is left, or when Enter is pressed.
 *
 * Leaving the field empty is read as "no answer" rather than as zero: the model
 * keeps its value and the field snaps back to it. Type `0` to mean zero.
 */
export default function NumberInput({
  value,
  onCommit,
  onBlur,
  onKeyDown,
  ...props
}: Omit<InputProps, 'value' | 'onChange' | 'type'> & {
  /** The model value, shown whenever the field is not being edited. */
  value: number | string
  /** Called with the typed number when the field is left or Enter is pressed. */
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value === '' ? '' : String(value))

  return (
    <Input
      {...props}
      type="number"
      value={shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        const typed = e.target.value.trim()
        setDraft(null)
        if (typed !== '') onCommit(Number(typed))
        onBlur?.(e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        onKeyDown?.(e)
      }}
    />
  )
}
