/**
 * The application mark.
 *
 * Same artwork as the shipped icon (`build/make-icon.py` draws it with PIL for the
 * .ico/.png assets): a flat blue tile carrying a play glyph that emits two
 * broadcast arcs. Flat on purpose — one solid colour and solid white shapes, no
 * gradient, no highlight, no shadow — so the header mark and the taskbar icon are
 * the same picture at two sizes.
 *
 * Colours come from the theme tokens, which resolve to the same blue the icon
 * generator uses. `title` is only rendered when the mark stands on its own (a
 * screen reader would otherwise read "graphic" with no name); in the header the
 * product name sits next to it, so it is marked decorative instead.
 */
export default function BrandMark({
  size = 30,
  className,
  title
}: {
  size?: number
  className?: string
  title?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      <defs>
        {/* A gentle luminance ramp over the theme's primary: enough material to read
            as a surface rather than as flat fill, no gloss. Same numbers as the icon
            generator. */}
        <linearGradient id="brand-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="50%" stopColor="#2563eb" />
          <stop offset="100%" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="7.8" fill="url(#brand-tile)" />
      {/*
        Placement: the visible weight (solid triangle plus the bright inner arc) sits
        on the tile's middle, with the fading outer arc allowed to overhang to the
        right — centring the whole outline instead makes the mark read as pushed left.
        The tip-to-arc gap is what keeps the two readable as separate shapes at 16 px.
      */}
      <path d="M9.2 9 L17.6 16 L9.2 23 Z" fill="var(--primary-foreground)" />
      <path
        d="M20.8 11.71 A5.6 5.6 0 0 1 20.8 20.29"
        stroke="var(--primary-foreground)"
        strokeWidth="2.1"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M23.25 9.53 A9 9 0 0 1 23.25 22.47"
        stroke="var(--primary-foreground)"
        strokeWidth="2.1"
        strokeLinecap="round"
        fill="none"
        opacity="0.55"
      />
    </svg>
  )
}
