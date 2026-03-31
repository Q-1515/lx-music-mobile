import { NativeModules, Platform } from 'react-native'

type NowPlayingInfoMetadata = {
  title?: string
  artist?: string
  album?: string
  artwork?: string
  duration?: number
  elapsedTime?: number
  playbackRate?: number
}

type NowPlayingStateOptions = {
  elapsedTime?: number
  playbackRate?: number
}

type NativeNowPlayingModule = {
  updateNowPlayingInfo?: (metadata: NowPlayingInfoMetadata) => Promise<void>
  playNowPlaying?: (options?: NowPlayingStateOptions) => Promise<void>
  pauseNowPlaying?: (options?: NowPlayingStateOptions) => Promise<void>
  stopNowPlaying?: (options?: NowPlayingStateOptions) => Promise<void>
  clearNowPlayingInfo?: () => Promise<void>
}

const NowPlayingModule = NativeModules.NowPlayingModule as NativeNowPlayingModule | undefined

const hasMethod = <K extends keyof NativeNowPlayingModule>(method: K) => {
  return Platform.OS == 'ios' && typeof NowPlayingModule?.[method] == 'function'
}

export const updateNowPlayingInfo = async(metadata: NowPlayingInfoMetadata) => {
  if (!hasMethod('updateNowPlayingInfo')) return
  return NowPlayingModule?.updateNowPlayingInfo?.(metadata)
}

export const playNowPlaying = async(options: NowPlayingStateOptions = {}) => {
  if (!hasMethod('playNowPlaying')) return
  return NowPlayingModule?.playNowPlaying?.(options)
}

export const pauseNowPlaying = async(options: NowPlayingStateOptions = {}) => {
  if (!hasMethod('pauseNowPlaying')) return
  return NowPlayingModule?.pauseNowPlaying?.(options)
}

export const stopNowPlaying = async(options: NowPlayingStateOptions = {}) => {
  if (!hasMethod('stopNowPlaying')) return
  return NowPlayingModule?.stopNowPlaying?.(options)
}

export const clearNowPlayingInfo = async() => {
  if (!hasMethod('clearNowPlayingInfo')) return
  return NowPlayingModule?.clearNowPlayingInfo?.()
}
