import { Platform } from 'react-native'
import settingState from '@/store/setting/state'
import {
  getStreamingFlacBufferedPosition,
  getStreamingFlacDuration,
  getStreamingFlacPosition,
  getStreamingFlacState,
  isStreamingFlacSupported,
  onStreamingFlacEvent,
  openStreamingFlac,
  pauseStreamingFlac,
  resetStreamingFlac,
  resumeStreamingFlac,
  setStreamingFlacRate,
  setStreamingFlacVolume,
  seekStreamingFlac,
  stopStreamingFlac,
  type StreamingFlacEvent,
} from '@/utils/nativeModules/streamingFlac'

type NativeFlacState = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'stopped'

type NativeFlacEvent =
  | { type: 'state', state: NativeFlacState, position?: number, duration?: number }
  | { type: 'ended', state?: NativeFlacState, position?: number, duration?: number, success?: boolean }
  | { type: 'warning', message?: string, state?: NativeFlacState, position?: number, duration?: number, code?: number, statusName?: string }
  | { type: 'error', message?: string, state?: NativeFlacState, position?: number, duration?: number }

interface NativeFlacPlaybackContext {
  musicInfo: LX.Player.PlayMusic
  url: string
  quality: LX.Quality | null
}

interface NativeFlacPlaybackSnapshot extends NativeFlacPlaybackContext {
  position: number
  state: NativeFlacState
}

const preferredPreciseQualities = new Set<LX.Quality>(['flac', 'flac24bit'])
const defaultUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile'

let currentTrackId = ''
let currentState: NativeFlacState = 'idle'
let currentMode: 'none' | 'stream' = 'none'
let currentPlaybackContext: NativeFlacPlaybackContext | null = null

const clearCurrentContext = (nextState: NativeFlacState) => {
  currentTrackId = ''
  currentMode = 'none'
  currentState = nextState
  currentPlaybackContext = null
}

const getMusicInfo = (musicInfo: LX.Player.PlayMusic) => 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
const isRemoteUrl = (url: string) => /^https?:\/\//i.test(url)

export const isNativeFlacPlayerAvailable = () => Platform.OS == 'ios' && isStreamingFlacSupported

export const shouldUseNativeFlacPlayer = async(musicInfo: LX.Player.PlayMusic, _url: string, quality?: LX.Quality | null) => {
  if (!isNativeFlacPlayerAvailable()) return false

  if (quality != null) return preferredPreciseQualities.has(quality)
  return getMusicInfo(musicInfo).source != 'local' && preferredPreciseQualities.has(settingState.setting['player.playQuality'])
}

export const prefetchNativeFlacPlayback = async(musicInfo: LX.Player.PlayMusic, url: string, quality?: LX.Quality | null) => {
  if (!await shouldUseNativeFlacPlayer(musicInfo, url, quality)) return false
  return isRemoteUrl(url)
}

export const startNativeFlacPlayback = async(musicInfo: LX.Player.PlayMusic, url: string, position: number, autoplay = true, quality: LX.Quality | null = null) => {
  await resetNativeFlacPlayback().catch(() => {})
  const nextTrackId = `nativeflac://${getMusicInfo(musicInfo).id}`
  const playbackContext: NativeFlacPlaybackContext = {
    musicInfo,
    url,
    quality: quality ?? null,
  }

  if (isRemoteUrl(url) && isStreamingFlacSupported) {
    currentTrackId = nextTrackId
    currentMode = 'stream'
    currentState = 'loading'
    try {
      await openStreamingFlac(url, { 'User-Agent': defaultUserAgent }, settingState.setting['player.volume'], settingState.setting['player.playbackRate'], autoplay)
      const seekPosition = position > 0
        ? await seekStreamingFlac(position).catch(() => position)
        : 0
      currentState = autoplay
        ? (seekPosition > 0 ? 'buffering' : 'loading')
        : 'paused'
      currentPlaybackContext = playbackContext
      return {
        position: seekPosition,
        duration: 0,
        trackId: nextTrackId,
      }
    } catch (err) {
      currentTrackId = ''
      currentMode = 'none'
      currentState = 'idle'
      throw err
    }
  }

  throw new Error('Native local FLAC playback is disabled')
}

export const pauseNativeFlacPlayback = async() => {
  if (!currentTrackId) return
  if (currentMode == 'stream') {
    await pauseStreamingFlac().catch(() => {})
  }
  currentState = 'paused'
}

export const resumeNativeFlacPlayback = async() => {
  if (!currentTrackId) return
  if (currentMode == 'stream') {
    await resumeStreamingFlac()
  }
  currentState = 'playing'
}

export const stopNativeFlacPlayback = async(reset = false) => {
  if (!currentTrackId) return
  const trackId = currentTrackId
  const mode = currentMode
  if (currentMode == 'stream') {
    if (reset) await resetStreamingFlac().catch(() => {})
    else await stopStreamingFlac().catch(() => {})
  }
  if (currentTrackId == trackId && currentMode == mode) clearCurrentContext(reset ? 'idle' : 'stopped')
}

export const resetNativeFlacPlayback = async() => {
  const mode = currentMode
  const trackId = currentTrackId

  if (isStreamingFlacSupported) await resetStreamingFlac().catch(() => {})

  if (currentMode == mode && currentTrackId == trackId) clearCurrentContext('idle')
}

export const seekNativeFlacPlayback = async(position: number) => {
  if (!currentTrackId) return position
  if (currentMode == 'stream') {
    return seekStreamingFlac(position)
  }
  return position
}

export const getNativeFlacPosition = async() => {
  if (!currentTrackId) return 0
  if (currentMode == 'stream') return getStreamingFlacPosition().catch(() => 0)
  return 0
}

export const getNativeFlacBufferedPosition = async() => {
  if (!currentTrackId) return 0
  if (currentMode == 'stream') {
    const [buffered, duration] = await Promise.all([
      getStreamingFlacBufferedPosition().catch(() => 0),
      getStreamingFlacDuration().catch(() => 0),
    ])
    if (!duration) return buffered
    return Math.min(buffered, duration)
  }
  return getNativeFlacDuration()
}

export const getNativeFlacDuration = async() => {
  if (!currentTrackId) return 0
  if (currentMode == 'stream') return getStreamingFlacDuration().catch(() => 0)
  return 0
}

export const getNativeFlacState = async() => {
  if (!currentTrackId) return currentState
  if (currentMode == 'stream') {
    currentState = await getStreamingFlacState().catch(() => currentState)
    return currentState
  }
  return currentState
}

export const setNativeFlacVolume = async(volume: number) => {
  if (!currentTrackId) return
  if (currentMode == 'stream') {
    await setStreamingFlacVolume(volume).catch(() => {})
  }
}

export const setNativeFlacRate = async(rate: number) => {
  if (!currentTrackId) return
  if (currentMode == 'stream') {
    await setStreamingFlacRate(rate).catch(() => {})
  }
}

export const isNativeFlacActive = () => !!currentTrackId

export const getNativeFlacTrackId = () => currentTrackId

export const snapshotNativeFlacPlayback = async(): Promise<NativeFlacPlaybackSnapshot | null> => {
  if (!currentTrackId || !currentPlaybackContext) return null
  const [position, state] = await Promise.all([
    getNativeFlacPosition().catch(() => 0),
    getNativeFlacState().catch(() => currentState),
  ])
  return {
    ...currentPlaybackContext,
    position,
    state,
  }
}

export const restoreNativeFlacPlayback = async(snapshot: NativeFlacPlaybackSnapshot) => {
  const shouldAutoplay = !['idle', 'paused', 'stopped'].includes(snapshot.state)
  return startNativeFlacPlayback(snapshot.musicInfo, snapshot.url, snapshot.position, shouldAutoplay, snapshot.quality)
}

export const onNativeFlacPlayerEvent = (listener: (event: NativeFlacEvent) => void) => {
  const subscriptions: Array<() => void> = []

  const removeStreaming = onStreamingFlacEvent((event: StreamingFlacEvent) => {
    if (currentMode != 'stream') return
    switch (event.type) {
      case 'state':
        currentState = event.state
        listener({
          type: 'state',
          state: currentState,
          position: event.position,
          duration: event.duration,
        })
        break
      case 'ended':
        currentState = 'stopped'
        currentTrackId = ''
        currentMode = 'none'
        listener({
          type: 'ended',
          state: 'stopped',
          position: event.position,
          duration: event.duration,
          success: true,
        })
        break
      case 'error':
        currentState = 'paused'
        listener({
          type: 'error',
          message: event.message,
          state: 'paused',
          position: event.position,
          duration: event.duration,
        })
        break
      case 'warning':
        listener({
          type: 'warning',
          message: event.message,
          state: event.state,
          position: event.position,
          duration: event.duration,
          code: event.code,
          statusName: event.statusName,
        })
        break
    }
  })
  subscriptions.push(removeStreaming)

  return () => {
    for (const remove of subscriptions) remove()
  }
}
