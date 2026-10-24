/**
 * Store write failures used to go to `console.error` only. The settings cache is
 * updated before the file is written, so the UI kept showing the new value while
 * the next launch reverted to the old one — with no visible reason. This is the
 * single hook the application installs to surface those failures in the log.
 */

export type StoreArea = 'settings' | 'presets' | 'playlist' | 'logs'

type StoreErrorHandler = (area: StoreArea, error: unknown) => void

let handler: StoreErrorHandler | null = null

export function setStoreErrorHandler(fn: StoreErrorHandler | null): void {
  handler = fn
}

export function reportStoreError(area: StoreArea, error: unknown): void {
  console.error(`[${area}] write failed:`, error)
  try {
    handler?.(area, error)
  } catch {
    /* logging a logging failure must not throw */
  }
}
