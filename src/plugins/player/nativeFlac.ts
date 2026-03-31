import { NativeEventEmitter, NativeModules, Platform } from 'react-native'
import { downloadFile, existsFile, mkdir, temporaryDirectoryPath, unlink } from '@/utils/fs'
import { stringMd5 } from 'react-native-quick-md5'
import settingState from '@/store/setting/state'

type NativeFlacState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped'

type NativeFlacEvent =
  | { type: 'state', state: NativeFlacState, position?: number, duration?: number }
  | { type: 'ended', state?: NativeFlacState, position?: number, duration?: number, success?: boolean }
  | { type: 'error', message?: string, state?: NativeFlacState, position?: number, duration?: number }

interface NativeFlacPlayerModule {
  playFile: (path: string, position: number, volume: number, rate: number) => Promise<{ position: number, duration: number }>
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

let currentTrackId = ''
let currentState: NativeFlacState = 'idle'

const normalizePath = (path: string) => path.startsWith('file://')
  ? decodeURIComponent(path.replace(/^file:\/\//, ''))
  : decodeURIComponent(path)

const getMusicInfo = (musicInfo: LX.Player.PlayMusic) => 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo

const getQualityExt = (musicInfo: LX.Player.PlayMusic, url: string) => {
  const info = getMusicInfo(musicInfo)
  if (info.source == 'local') return info.meta.ext?.toLowerCase() || 'flac'
  const ext = /\.([a-z0-9]+)(?:$|[?#])/i.exec(url)?.[1]?.toLowerCase()
  if (ext) return ext
  return preferredPreciseQualities.has(settingState.setting['player.playQuality']) ? 'flac' : 'mp3'
}

const ensureCacheDir = async() => {
  await mkdir(cacheDir).catch(() => {})
}

const wait = async(ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const buildCachePath = (musicInfo: LX.Player.PlayMusic, url: string) => {
  const ext = getQualityExt(musicInfo, url)
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
  if (!/^https?:\/\//i.test(url)) return normalizePath(url)

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

const playNativeFile = async(path: string, position: number) => {
  if (!NativeFlacPlayer) throw new Error('Native flac player is unavailable')
  return NativeFlacPlayer.playFile(path, position, settingState.setting['player.volume'], settingState.setting['player.playbackRate']).catch((err: Error & { lxHandled?: boolean }) => {
    err.lxHandled = true
    throw err
  })
}

export const isNativeFlacPlayerAvailable = () => Platform.OS == 'ios' && !!NativeFlacPlayer

export const shouldUseNativeFlacPlayer = (musicInfo: LX.Player.PlayMusic, url: string) => {
  if (!isNativeFlacPlayerAvailable()) return false

  const info = getMusicInfo(musicInfo)
  const ext = getQualityExt(musicInfo, url)
  if (ext == 'flac') return true
  if (info.source == 'local') return false

  const playQuality = settingState.setting['player.playQuality']
  if (!preferredPreciseQualities.has(playQuality)) return false
  return !!info.meta._qualitys.flac || !!info.meta._qualitys.flac24bit
}

export const startNativeFlacPlayback = async(musicInfo: LX.Player.PlayMusic, url: string, position: number) => {
  if (!NativeFlacPlayer) throw new Error('Native flac player is unavailable')
  let path = await ensurePlayablePath(musicInfo, url)
  const nextTrackId = `nativeflac://${getMusicInfo(musicInfo).id}`
  currentState = 'loading'
  let info
  try {
    info = await playNativeFile(path, position)
  } catch (err) {
    if (/^https?:\/\//i.test(url)) {
      await unlink(path).catch(() => {})
      path = await ensurePlayablePath(musicInfo, url, true)
      info = await playNativeFile(path, position)
    } else throw err
  }
  currentTrackId = nextTrackId
  currentState = 'playing'
  return {
    ...info,
    path,
    trackId: nextTrackId,
  }
}

export const pauseNativeFlacPlayback = async() => {
  if (!NativeFlacPlayer || !currentTrackId) return
  await NativeFlacPlayer.pause()
  currentState = 'paused'
}

export const resumeNativeFlacPlayback = async() => {
  if (!NativeFlacPlayer || !currentTrackId) return
  await NativeFlacPlayer.resume()
  currentState = 'playing'
}

export const stopNativeFlacPlayback = async(reset = false) => {
  if (!NativeFlacPlayer || !currentTrackId) return
  const trackId = currentTrackId
  if (reset) await NativeFlacPlayer.reset()
  else await NativeFlacPlayer.stop()
  if (currentTrackId == trackId) currentTrackId = ''
  currentState = reset ? 'idle' : 'stopped'
}

export const resetNativeFlacPlayback = async() => {
  if (!NativeFlacPlayer) return
  await NativeFlacPlayer.reset()
  currentTrackId = ''
  currentState = 'idle'
}

export const seekNativeFlacPlayback = async(position: number) => {
  if (!NativeFlacPlayer) return position
  return NativeFlacPlayer.seekTo(position)
}

export const getNativeFlacPosition = async() => {
  if (!NativeFlacPlayer || !currentTrackId) return 0
  return NativeFlacPlayer.getPosition()
}

export const getNativeFlacDuration = async() => {
  if (!NativeFlacPlayer || !currentTrackId) return 0
  return NativeFlacPlayer.getDuration()
}

export const getNativeFlacState = async() => {
  if (!NativeFlacPlayer || !currentTrackId) return currentState
  currentState = await NativeFlacPlayer.getState()
  return currentState
}

export const setNativeFlacVolume = async(volume: number) => {
  if (!NativeFlacPlayer || !currentTrackId) return
  await NativeFlacPlayer.setVolume(volume)
}

export const setNativeFlacRate = async(rate: number) => {
  if (!NativeFlacPlayer || !currentTrackId) return
  await NativeFlacPlayer.setRate(rate)
}

export const isNativeFlacActive = () => !!currentTrackId

export const getNativeFlacTrackId = () => currentTrackId

export const onNativeFlacPlayerEvent = (listener: (event: NativeFlacEvent) => void) => {
  if (!eventEmitter) return () => {}
  const subscription = eventEmitter.addListener('flac-player-event', (event: NativeFlacEvent) => {
    switch (event.type) {
      case 'state':
        currentState = event.state
        break
      case 'ended':
        currentState = 'stopped'
        currentTrackId = ''
        break
      case 'error':
        currentState = 'paused'
        break
    }
    listener(event)
  })
  return () => {
    subscription.remove()
  }
}
