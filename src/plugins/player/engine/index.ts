import TrackPlayer, { State } from 'react-native-track-player'
import { Platform } from 'react-native'
import { isNativeFlacActive, getNativeFlacState } from '../nativeFlac'
import { UnifiedPlayerEventBus } from './EventBus'
import { createTrackPlayerDriver } from './drivers/trackPlayerDriver'
import { createNativeFlacDriver } from './drivers/nativeFlacDriver'
import type { UnifiedPlaybackState, UnifiedPlayerEvent } from './types'

const bus = new UnifiedPlayerEventBus()

const shouldIgnoreTrackPlayerLifecycle = () => {
  return Platform.OS == 'ios' && (isNativeFlacActive() || global.lx.playerStatus.ignoreTrackPlayerLifecycle)
}

const trackPlayerDriver = createTrackPlayerDriver(bus, shouldIgnoreTrackPlayerLifecycle)
const nativeFlacDriver = createNativeFlacDriver(bus)

let isInitialized = false

export const initUnifiedPlayerEngine = () => {
  if (isInitialized) return
  trackPlayerDriver.init()
  nativeFlacDriver.init()
  isInitialized = true
}

export const onUnifiedPlayerEvent = (listener: (event: UnifiedPlayerEvent) => void) => {
  initUnifiedPlayerEngine()
  return bus.on(listener)
}

export const getUnifiedPlaybackState = async(): Promise<UnifiedPlaybackState> => {
  initUnifiedPlayerEngine()
  if (Platform.OS == 'ios' && isNativeFlacActive()) {
    const state = await getNativeFlacState().catch(() => 'idle' as const)
    switch (state) {
      case 'loading':
        return 'loading'
      case 'buffering':
        return 'buffering'
      case 'playing':
        return 'playing'
      case 'paused':
        return 'paused'
      case 'stopped':
        return 'stopped'
      case 'idle':
      default:
        return 'idle'
    }
  }
  const state = await TrackPlayer.getState().catch(() => State.None)
  switch (state) {
    case State.Playing:
      return 'playing'
    case State.Buffering:
      return 'buffering'
    case State.Connecting:
      return 'loading'
    case State.Paused:
      return 'paused'
    case State.Stopped:
      return 'stopped'
    case State.Ready:
      return 'paused'
    case State.None:
    default:
      return 'idle'
  }
}
