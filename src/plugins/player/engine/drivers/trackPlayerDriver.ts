import TrackPlayer, { Event as TPEvent, State as TPState } from 'react-native-track-player'
import { Platform } from 'react-native'
import { getCurrentTrackId } from '../../playList'
import type { UnifiedPlaybackState } from '../types'
import type { UnifiedPlayerEventBus } from '../EventBus'

const mapTrackPlayerState = (state: TPState): UnifiedPlaybackState | null => {
  switch (state) {
    case TPState.Playing:
      return 'playing'
    case TPState.Buffering:
      return 'buffering'
    case TPState.Connecting:
      return 'loading'
    case TPState.Paused:
      return 'paused'
    case TPState.Stopped:
      return 'stopped'
    case TPState.Ready:
      return 'paused'
    case TPState.None:
    default:
      return 'idle'
  }
}

export const createTrackPlayerDriver = (bus: UnifiedPlayerEventBus, shouldIgnoreLifecycle: () => boolean) => {
  let isInitialized = false

  const init = () => {
    if (isInitialized) return

    TrackPlayer.addEventListener(TPEvent.PlaybackState, async(info) => {
      if (shouldIgnoreLifecycle()) return
      const state = mapTrackPlayerState(info.state as TPState)
      if (!state) return
      bus.emit({ type: 'state', driver: 'trackPlayer', state })
    })

    TrackPlayer.addEventListener(TPEvent.PlaybackError, async(err: any) => {
      if (shouldIgnoreLifecycle()) return
      bus.emit({ type: 'error', driver: 'trackPlayer', error: err })
    })

    TrackPlayer.addEventListener(TPEvent.PlaybackTrackChanged, async(info: any) => {
      if (shouldIgnoreLifecycle()) return
      const trackId = await getCurrentTrackId().catch(() => '')
      bus.emit({
        type: 'trackChanged',
        driver: 'trackPlayer',
        info,
        trackId: trackId ?? '',
      })
    })

    const playbackQueueEndedEvent = ((TPEvent as unknown as { PlaybackQueueEnded?: TPEvent }).PlaybackQueueEnded ?? 'playback-queue-ended') as TPEvent
    TrackPlayer.addEventListener(playbackQueueEndedEvent, async(info: any) => {
      if (shouldIgnoreLifecycle()) return
      if (Platform.OS != 'ios') return
      bus.emit({
        type: 'ended',
        driver: 'trackPlayer',
        position: info?.position,
        duration: info?.duration,
      })
    })

    isInitialized = true
  }

  return { init }
}
