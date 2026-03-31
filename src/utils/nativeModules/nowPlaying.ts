import { NativeModules, Platform } from 'react-native'

const { NowPlayingModule } = NativeModules

export const updateNowPlayingInfo = async(metadata: {
  title?: string
  artist?: string
  album?: string
  artwork?: string
  duration?: number
  elapsedTime?: number
  playbackRate?: number
}) => {
  if (Platform.OS != 'ios' || typeof NowPlayingModule?.updateNowPlayingInfo != 'function') return
  return NowPlayingModule.updateNowPlayingInfo(metadata)
}

export const clearNowPlayingInfo = async() => {
  if (Platform.OS != 'ios' || typeof NowPlayingModule?.clearNowPlayingInfo != 'function') return
  return NowPlayingModule.clearNowPlayingInfo()
}
