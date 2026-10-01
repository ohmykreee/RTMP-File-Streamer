import type { StreamerApi } from '@shared/types'

declare global {
  interface Window {
    streamer: StreamerApi
  }
}

export {}
