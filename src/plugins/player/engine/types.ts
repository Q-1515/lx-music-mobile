export type UnifiedPlaybackState =
  | 'idle'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'stopped'

export type UnifiedDriverName = 'trackPlayer' | 'nativeFlac'

export type UnifiedPlayerEvent =
  | {
    type: 'state'
    driver: UnifiedDriverName
    state: UnifiedPlaybackState
  }
  | {
    type: 'error'
    driver: UnifiedDriverName
    error: any
  }
  | {
    type: 'ended'
    driver: UnifiedDriverName
    position?: number
    duration?: number
    success?: boolean
  }
  | {
    type: 'trackChanged'
    driver: UnifiedDriverName
    info: any
    trackId: string
  }
