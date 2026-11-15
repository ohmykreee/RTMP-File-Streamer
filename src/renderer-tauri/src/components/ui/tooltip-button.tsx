import type { ComponentProps } from 'react'
import { Button } from './button'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

/**
 * A Button whose hover/focus hint uses the app's one tooltip implementation.
 *
 * Native `title` attributes and the styled tooltip were both in use, so the same
 * kind of control could show two different popups. Everything that needs a hint
 * goes through here (or the same `Tooltip` primitives) instead.
 */
export function TooltipButton({
  label,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button {...props} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
