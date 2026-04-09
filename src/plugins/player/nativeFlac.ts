import { NativeEventEmitter, NativeModules, Platform } from 'react-native'
import { downloadFile, existsFile, mkdir, temporaryDirectoryPath, unlink } from '@/utils/fs'
import { stringMd5 } from 'react-native-quick-md5'
import { checkUrl } from '@/utils/request'
import settingState from '@/store/setting/state'
import {
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

interface NativeFlacPlayerModule {
  playFile: (path: string, position: number, volume: number, rate: number, autoplay?: boolean) => Promise<{ position: number, duration: number }>
  resume: () => Promise<void>
  pause: () => Promise<void>
  stop: () => Promise<void>
  reset: () => Promise<void>
  seekTo: (position: number) => Promise<number>
  setVolume: (volume: number) => Promise<void>
  setRate: (rate: number) => Promise<void>
  getPosition: () => Promise<number>
  getDuration: () => Promise<number>
  getState: () => Promise<NativeFlacState>
  addListener?: (eventName: string) => void
  removeListeners?: (count: number) => void
}

interface NativeFlacEventModule extends NativeFlacPlayerModule {
  addListener: (eventName: string) => void
  removeListeners: (count: number) => void
}

const NativeFlacPlayer = NativeModules.FlacPlayerModule as NativeFlacPlayerModule | undefined
const NativeFlacEventPlayer = NativeModules.FlacPlayerModule as NativeFlacEventModule | undefined
const eventEmitter = Platform.OS == 'ios' && typeof NativeFlacEventPlayer?.addListener == 'function' && typeof NativeFlacEventPlayer?.removeListeners == 'function'
  ? new NativeEventEmitter(NativeFlacEventPlayer)
  : null

const cacheDir = `${temporaryDirectoryPath}/NativeFlacPlayer`
const downloadingMap = new Map<string, Promise<string>>()
const preferredPreciseQualities = new Set<LX.Quality>(['flac', 'flac24bit'])
const retryDelay = 800
const defaultUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile'

let currentTrackId = ''
let currentState: NativeFlacState = 'idle'
let currentMode: 'none' | 'file' | 'stream' = 'none'

const clearCurrentContext = (nextState: NativeFlacState) => {
  currentTrackId = ''
  currentMode = 'none'
  currentState = nextState
}

const normalizePath = (path: string) => path.startsWith('file://')
  ? decodeURIComponent(path.replace(/^file:\/\//, ''))
  : decodeURIComponent(path)

const getMusicInfo = (musicInfo: LX.Player.PlayMusic) => 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
const isRemoteUrl = (url: string) => /^https?:\/\//i.test(url)

const getQualityExt = (musicInfo: LX.Player.PlayMusic) => {
  const info = getMusicInfo(musicInfo)
  if (info.source == 'local') return info.meta.ext?.toLowerCase() ?? 'flac'
  return preferredPreciseQualities.has(settingState.setting['player.playQuality']) ? 'flac' : 'mp3'
}

const ensureCacheDir = async() => {
  await mkdir(cacheDir).catch(() => {})
}

const wait = async(ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const buildCachePath = (musicInfo: LX.Player.PlayMusic, url: string) => {
  const ext = getQualityExt(musicInfo)
  return `${cacheDir}/${stringMd5(`${getMusicInfo(musicInfo).id}|${url}`)}.${ext}`
}

const downloadToCache = async(url: string, cachePath: string, retry = 1): Promise<string> => {
  const { promise } = downloadFile(url, cachePath, {
    background: false,
    cacheable: false,
    discretionary: false,
    readTimeout: 120_000,
    backgroundTimeout: 120_000,
  })

  try {
    const result = await promise
    if (result.statusCode && (result.statusCode < 200 || result.statusCode >= 400)) {
      throw new Error(`download failed: ${result.statusCode}`)
    }
    return cachePath
  } catch (err) {
    await unlink(cachePath).catch(() => {})
    if (retry > 0) {
      await wait(retryDelay)
      return downloadToCache(url, cachePath, retry - 1)
    }
    throw err
  }
}

const ensurePlayablePath = async(musicInfo: LX.Player.PlayMusic, url: string, forceRedownload = false) => {
  if (!isRemoteUrl(url)) return normalizePath(url)

  await ensureCacheDir()
  const cachePath = buildCachePath(musicInfo, url)
  if (forceRedownload) await unlink(cachePath).catch(() => {})
  if (!forceRedownload && await existsFile(cachePath)) return cachePath

  let task = downloadingMap.get(cachePath)
  if (!task) {
    task = downloadToCache(url, cachePath).finally(() => {
      downloadingMap.delete(cachePath)
    })
    downloadingMap.set(cachePath, task)
  }

  return task
}

const playNativeFile = async(path: string, position: number, autoplay = true) => {
  if (!NativeFlacPlayer) throw new Error('Native flac player is unavailable')
  return NativeFlacPlayer.playFile(path, position, settingState.setting['player.volume'], settingState.setting['player.playbackRate'], autoplay).catch((err: Error & { lxHandled?: boolean }) => {
    err.lxHandled = true
    throw err
  })
}

export const isNativeFlacPlayerAvailable = () => Platform.OS == 'ios' && (!!NativeFlacPlayer || isStreamingFlacSupported)

export const shouldUseNativeFlacPlayer = async(musicInfo: LX.Player.PlayMusic, _url: string, quality?: LX.Quality | null) => {
  if (!isNativeFlacPlayerAvailable()) return false

  const info = getMusicInfo(musicInfo)
  if (quality != null) return preferredPreciseQualities.has(quality)
  return info.source == 'local' ? info.meta.ext?.toLowerCase() == 'flac' : false
}

export const prefetchNativeFlacPlayback = async(musicInfo: LX.Player.PlayMusic, url: string, quality?: LX.Quality | null) => {
  if (!await shouldUseNativeFlacPlayer(musicInfo, url, quality)) return false
  if (!isRemoteUrl(url)) return true

  if (isStreamingFlacSupported) {
    await checkUrl(url)
    return true
  }

  await ensurePlayablePath(musicInfo, url)
  return true
}

export const startNativeFlacPlayback = async(musicInfo: LX.Player.PlayMusic, url: string, position: number, autoplay = true) => {
  await resetNativeFlacPlayback().catch(() => {})
  const nextTrackId = `nativeflac://${getMusicInfo(musicInfo).id}`

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
      return {
        position: seekPosition,
        duration: 0,
        path: url,
        trackId: nextTrackId,
      }
    } catch (err) {
      currentTrackId = ''
      currentMode = 'none'
      currentState = 'idle'
      throw err
    }
  }

  if (!NativeFlacPlayer) throw new Error('Native flac player is unavailable')
  let path = await ensurePlayablePath(musicInfo, url)
  currentState = autoplay ? 'loading' : 'paused'
  let info
  try {
    info = await playNativeFile(path, position, autoplay)
  } catch (err) {
    if (isRemoteUrl(url)) {
      await unlink(path).catch(() => {})
      path = await ensurePlayablePath(musicInfo, url, true)
      info = await playNativeFile(path, position, autoplay)
    } else throw err
  }
  currentTrackId = nextTrackId
  currentMode = 'file'
  currentState = autoplay ? 'playing' : 'paused'
  return {
    ...info,
    path,
    trackId: nextTrackId,
  }
}

export const pauseNativeFlacPlayback = async() => {
  if (!currentTrackId) return
  if (currentMode == 'stream') {
    await pauseStreamingFlac().catch(() => {})
  } else if (NativeFlacPlayer) {
    await NativeFlacPlayer.pause()
  }
  currentState = 'paused'
}

export const resumeNativeFlacPlayback = async() => {
  if (!currentTrackId) return
  if (currentMode == 'stream') {
    await resumeStreamingFlac()
  } else if (NativeFlacPlayer) {
    await NativeFlacPlayer.resume()
  } else {
    return
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
  } else if (NativeFlacPlayer) {
    if (reset) await NativeFlacPlayer.reset()
    else await NativeFlacPlayer.stop()
  }
  if (currentTrackId == trackId && currentMode == mode) clearCurrentContext(reset ? 'idle' : 'stopped')
}

export const resetNativeFlacPlayback = async() => {
  const mode = currentMode
  const trackId = currentTrackId

  if (NativeFlacPlayer) await NativeFlacPlayer.reset().catch(() => {})
  if (isStreamingFlacSupported) await resetStreamingFlac().catch(() => {})

  if (currentMode == mode && currentTrackId == trackId) clearCurrentContext('idle')
}

export const seekNativeFlacPlayback = async(position: number) => {
  if (!currentTrackId) return position
  if (currentMode == 'stream') {
    return seekStreamingFlac(position)
  }
  if (!NativeFlacPlayer) return position
  return NativeFlacPlayer.seekTo(position)
}

export const getNativeFlacPosition = async() => {
  if (!currentTrackId) return 0
  if (currentMode == 'stream') return getStreamingFlacPosition().catch(() => 0)
  if (!NativeFlacPlayer) return 0
  return NativeFlacPlayer.getPosition()
}

export const getNativeFlacDuration = async() => {
  if (!currentTrackId) return 0
  if (currentMode == 'stream') return getStreamingFlacDuration().catch(() => 0)
  if (!NativeFlacPlayer) return 0
  return NativeFlacPlayer.getDuration()
}

export const getNativeFlacState = async() => {
  if (!currentTrackId) return currentState
  if (currentMode == 'stream') {
    currentState = await getStreamingFlacState().catch(() => currentState)
    return currentState
  }
  if (!NativeFlacPlayer) return currentState
  currentState = await NativeFlacPlayer.getState()
  return currentState
}

export const setNativeFlacVolume = async(volume: number) => {
  if (!currentTrackId) return
  if (currentMode == 'stream') {
    await setStreamingFlacVolume(volume).catch(() => {})
    return
  }
  if (!NativeFlacPlayer) return
  await NativeFlacPlayer.setVolume(volume)
}

export const setNativeFlacRate = async(rate: number) => {
  if (!currentTrackId) return
  if (currentMode == 'stream') {
    await setStreamingFlacRate(rate).catch(() => {})
    return
  }
  if (!NativeFlacPlayer) return
  await NativeFlacPlayer.setRate(rate)
}

export const isNativeFlacActive = () => !!currentTrackId

export const getNativeFlacTrackId = () => currentTrackId

export const onNativeFlacPlayerEvent = (listener: (event: NativeFlacEvent) => void) => {
  const subscriptions: Array<() => void> = []

  if (eventEmitter) {
    const subscription = eventEmitter.addListener('flac-player-event', (event: NativeFlacEvent) => {
      if (currentMode != 'file') return
      switch (event.type) {
        case 'state':
          currentState = event.state
          break
        case 'ended':
          currentState = 'stopped'
          currentTrackId = ''
          currentMode = 'none'
          break
        case 'error':
          currentState = 'paused'
          break
      }
      listener(event)
    })
    subscriptions.push(() => {
      subscription.remove()
    })
  }

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
