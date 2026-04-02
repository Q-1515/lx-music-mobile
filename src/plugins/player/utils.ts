import TrackPlayer, { Capability, Event, RepeatMode, State } from 'react-native-track-player'
import BackgroundTimer from 'react-native-background-timer'
import { clearTracks, playMusic as handlePlayMusic } from './playList'
import { existsFile, moveFile, privateStorageDirectoryPath, temporaryDirectoryPath } from '@/utils/fs'
import { toast } from '@/utils/tools'
import { NativeModules, Platform } from 'react-native'
import { getAccuratePosition, seekToTime } from './seek'
import { clearNowPlayingInfo } from '@/utils/nativeModules/nowPlaying'
import {
  getNativeFlacDuration,
  getNativeFlacPosition,
  isNativeFlacActive,
  getNativeFlacState,
  onNativeFlacPlayerEvent,
  pauseNativeFlacPlayback,
  resetNativeFlacPlayback,
  resumeNativeFlacPlayback,
  seekNativeFlacPlayback,
  setNativeFlacRate,
  setNativeFlacVolume,
  stopNativeFlacPlayback,
} from './nativeFlac'
// import { PlayerMusicInfo } from '@/store/modules/player/playInfo'


export { useBufferProgress } from './hook'

const NativeTrackPlayerModule = NativeModules.TrackPlayerModule as {
  updateNowPlayingMetadata?: (metadata: {
    title?: string
    artist?: string
    album?: string
    artwork?: string
    duration?: number
    elapsedTime?: number
    isLiveStream?: boolean
  }) => Promise<void>
  getPosition?: () => Promise<number>
  getDuration?: () => Promise<number>
  getCacheSize?: () => Promise<number>
  clearCache?: () => Promise<void>
}

const emptyIdRxp = /\/\/default$/
const tempIdRxp = /\/\/default$|\/\/default\/\/restorePlay$/
export const isEmpty = (trackId = global.lx.playerTrackId) => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return false
  // console.log(trackId)
  return !trackId || emptyIdRxp.test(trackId)
}
export const isTempId = (trackId = global.lx.playerTrackId) => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return false
  return !trackId || tempIdRxp.test(trackId)
}

// export const replacePlayTrack = async(newTrack, oldTrack) => {
//   console.log('replaceTrack')
//   await TrackPlayer.add(newTrack)
//   await TrackPlayer.skip(newTrack.id)
//   await TrackPlayer.remove(oldTrack.id)
// }

// let timeout
// let isFirstPlay = true
// const updateInfo = async track => {
//   if (isFirstPlay) {
//     // timeout = setTimeout(() => {
//     await delayUpdateMusicInfo(track)
//     isFirstPlay = false
//     // }, 500)
//   }
// }


// 解决快速切歌导致的通知栏歌曲信息与当前播放歌曲对不上的问题
// const debouncePlayMusicTools = {
//   prevPlayMusicPromise: Promise.resolve(),
//   trackInfo: {},
//   isDelayUpdate: false,
//   isDebounced: false,
//   delay: 1000,
//   delayTimer: null,
//   debounce(fn, delay = 100) {
//     let timer = null
//     let _tracks = null
//     let _time = null
//     return (tracks, time) => {
//       if (!this.isDebounced && _tracks != null) this.isDebounced = true
//       _tracks = tracks
//       _time = time
//       if (timer) {
//         BackgroundTimer.clearTimeout(timer)
//         timer = null
//       }
//       if (this.isDelayUpdate) {
//         if (this.updateDelayTimer) {
//           BackgroundTimer.clearTimeout(this.updateDelayTimer)
//           this.updateDelayTimer = null
//         }
//         timer = BackgroundTimer.setTimeout(() => {
//           timer = null
//           let tracks = _tracks
//           let time = _time
//           _tracks = null
//           _time = null
//           this.isDelayUpdate = false
//           fn(tracks, time)
//         }, delay)
//       } else {
//         this.isDelayUpdate = true
//         fn(tracks, time)
//         this.updateDelayTimer = BackgroundTimer.setTimeout(() => {
//           this.updateDelayTimer = null
//           this.isDelayUpdate = false
//         }, this.delay)
//       }
//     }
//   },
//   delayUpdateMusicInfo() {
//     if (this.delayTimer) BackgroundTimer.clearTimeout(this.delayTimer)
//     this.delayTimer = BackgroundTimer.setTimeout(() => {
//       this.delayTimer = null
//       if (this.trackInfo.tracks && this.trackInfo.tracks.length) delayUpdateMusicInfo(this.trackInfo.tracks[0])
//     }, this.delay)
//   },
//   init() {
//     return this.debounce((tracks, time) => {
//       tracks = [...tracks]
//       this.trackInfo.tracks = tracks
//       this.trackInfo.time = time
//       return this.prevPlayMusicPromise.then(() => {
//         // console.log('run')
//         if (this.trackInfo.tracks === tracks) {
//           this.prevPlayMusicPromise = handlePlayMusic(tracks, time).then(() => {
//             if (this.isDebounced) {
//               this.delayUpdateMusicInfo()
//               this.isDebounced = false
//             }
//           })
//         }
//       })
//     }, 200)
//   },
// }

const playMusic = ((fn: (musicInfo: LX.Player.PlayMusic, url: string, time: number, quality?: LX.Quality | null) => void, delay = 800) => {
  let delayTimer: number | null = null
  let isDelayRun = false
  let timer: number | null = null
  let _musicInfo: LX.Player.PlayMusic | null = null
  let _url = ''
  let _time = 0
  let _quality: LX.Quality | null = null
  return (musicInfo: LX.Player.PlayMusic, url: string, time: number, quality?: LX.Quality | null) => {
    _musicInfo = musicInfo
    _url = url
    _time = time
    _quality = quality ?? null
    if (timer) {
      BackgroundTimer.clearTimeout(timer)
      timer = null
    }
    if (isDelayRun) {
      if (delayTimer) {
        BackgroundTimer.clearTimeout(delayTimer)
        delayTimer = null
      }
      timer = BackgroundTimer.setTimeout(() => {
        timer = null
        let musicInfo = _musicInfo
        let url = _url
        let time = _time
        let quality = _quality
        _musicInfo = null
        _url = ''
        _time = 0
        _quality = null
        isDelayRun = false
        fn(musicInfo!, url, time, quality)
      }, delay)
    } else {
      isDelayRun = true
      fn(musicInfo, url, time, quality ?? null)
      delayTimer = BackgroundTimer.setTimeout(() => {
        delayTimer = null
        isDelayRun = false
      }, 500)
    }
  }
})((musicInfo, url, time, quality) => {
  handlePlayMusic(musicInfo, url, time, quality)
})

export const setResource = (musicInfo: LX.Player.PlayMusic, url: string, duration?: number, quality?: LX.Quality | null) => {
  playMusic(musicInfo, url, duration ?? 0, quality)
}

export const setPlay = async() => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return resumeNativeFlacPlayback()
  return TrackPlayer.play()
}
export const getPosition = async() => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return getNativeFlacPosition()
  return getAccuratePosition()
}
export const getDuration = async() => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return getNativeFlacDuration()
  if (Platform.OS == 'ios' && typeof NativeTrackPlayerModule?.getDuration == 'function') {
    return NativeTrackPlayerModule.getDuration()
  }
  return TrackPlayer.getDuration()
}
export const setStop = async() => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) {
    global.lx.playerTrackId = ''
    return stopNativeFlacPlayback()
  }
  await TrackPlayer.stop()
  if (Platform.OS != 'ios' && !isEmpty()) await TrackPlayer.skipToNext()
}
export const setLoop = async(loop: boolean) => TrackPlayer.setRepeatMode(loop ? RepeatMode.Off : RepeatMode.Track)

export const setPause = async() => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return pauseNativeFlacPlayback()
  return TrackPlayer.pause()
}
// export const skipToNext = () => TrackPlayer.skipToNext()
export const setCurrentTime = async(time: number) => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return seekNativeFlacPlayback(time)
  return seekToTime(time)
}
export const setVolume = async(num: number) => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return setNativeFlacVolume(num)
  return TrackPlayer.setVolume(num)
}
export const setPlaybackRate = async(num: number) => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return setNativeFlacRate(num)
  return TrackPlayer.setRate(num)
}
export const updateNowPlayingTitles = async(duration: number, title: string, artist: string, album: string) => {
  console.log('set playing titles', duration, title, artist, album)
  if (Platform.OS == 'ios') return Promise.resolve()
  return TrackPlayer.updateNowPlayingTitles(duration, title, artist, album)
}

export const resetPlay = async() => Promise.all([setPause(), setCurrentTime(0)])

export const isCached = async(url: string) => TrackPlayer.isCached(url)
export const getCacheSize = async() => {
  if (Platform.OS == 'ios') {
    if (typeof NativeTrackPlayerModule?.getCacheSize != 'function') return 0
    return NativeTrackPlayerModule.getCacheSize()
  }
  return TrackPlayer.getCacheSize()
}
export const clearCache = async() => {
  if (Platform.OS == 'ios') {
    if (typeof NativeTrackPlayerModule?.clearCache != 'function') return
    return NativeTrackPlayerModule.clearCache()
  }
  return TrackPlayer.clearCache()
}
export const migratePlayerCache = async() => {
  const newCachePath = temporaryDirectoryPath + '/TrackPlayer'
  if (await existsFile(newCachePath)) return
  const oldCachePath = privateStorageDirectoryPath + '/TrackPlayer'
  if (!await existsFile(oldCachePath)) return
  let timeout: number | null = BackgroundTimer.setTimeout(() => {
    timeout = null
    toast(global.i18n.t('player_cache_migrating'), 'long')
  }, 2_000)
  await moveFile(oldCachePath, newCachePath).finally(() => {
    if (timeout) BackgroundTimer.clearTimeout(timeout)
  })
}

export const destroy = async() => {
  if (global.lx.playerStatus.isIniting || !global.lx.playerStatus.isInitialized) return
  try {
    if (Platform.OS == 'ios') await resetNativeFlacPlayback().catch(() => {})
    await TrackPlayer.destroy()
  } finally {
    if (Platform.OS == 'ios') await clearNowPlayingInfo().catch(() => {})
    clearTracks()
    global.lx.playerStatus.isInitialized = false
  }
}

type PlayStatus = 'None' | 'Ready' | 'Playing' | 'Paused' | 'Stopped' | 'Buffering' | 'Connecting'

type NativePlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'stopped'

const mapNativeFlacPlayStatus = (state: NativePlayerState): PlayStatus => {
  switch (state) {
    case 'loading':
      return 'Connecting'
    case 'buffering':
      return 'Buffering'
    case 'playing':
      return 'Playing'
    case 'paused':
      return 'Paused'
    case 'stopped':
      return 'Stopped'
    case 'idle':
    default:
      return 'None'
  }
}

export const onStateChange = async(listener: (state: PlayStatus) => void) => {
  const sub = TrackPlayer.addEventListener(Event.PlaybackState, state => {
    if (Platform.OS == 'ios' && isNativeFlacActive()) return
    let _state: PlayStatus
    switch (state) {
      case State.Ready:
        _state = 'Ready'
        break
      case State.Playing:
        _state = 'Playing'
        break
      case State.Paused:
        _state = 'Paused'
        break
      case State.Stopped:
        _state = 'Stopped'
        break
      case State.Buffering:
        _state = 'Buffering'
        break
      case State.Connecting:
        _state = 'Connecting'
        break
      case State.None:
      default:
        _state = 'None'
        break
    }
    listener(_state)
  })
  const removeNativeFlacListener = onNativeFlacPlayerEvent((event) => {
    switch (event.type) {
      case 'state':
        listener(mapNativeFlacPlayStatus(event.state))
        break
      case 'ended':
        listener('Stopped')
        break
      case 'error':
        listener('Paused')
        break
    }
  })
  if (Platform.OS == 'ios' && isNativeFlacActive()) {
    void getNativeFlacState().then((state) => {
      listener(mapNativeFlacPlayStatus(state))
    }).catch(() => {})
  }

  return () => {
    sub.remove()
    removeNativeFlacListener()
  }
}

/**
 * Subscription player state chuange event
 * @param options state change event
 * @returns remove event function
 */
// export const playState = callback => TrackPlayer.addEventListener('playback-state', callback)

const defaultUpdateOptions = Platform.OS == 'ios'
  ? {
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SeekTo,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ],
    }
  : {
      // Whether the player should stop running when the app is closed on Android
      // stopWithApp: true,

      // An array of media controls capabilities
      // Can contain CAPABILITY_PLAY, CAPABILITY_PAUSE, CAPABILITY_STOP, CAPABILITY_SEEK_TO,
      // CAPABILITY_SKIP_TO_NEXT, CAPABILITY_SKIP_TO_PREVIOUS, CAPABILITY_SET_RATING
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SeekTo,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ],

      notificationCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ],

      // // An array of capabilities that will show up when the notification is in the compact form on Android
      compactCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SkipToNext,
      ],

      // Icons for the notification on Android (if you don't like the default ones)
      // playIcon: require('./play-icon.png'),
      // pauseIcon: require('./pause-icon.png'),
      // stopIcon: require('./stop-icon.png'),
      // previousIcon: require('./previous-icon.png'),
      // nextIcon: require('./next-icon.png'),
      // icon: notificationIcon, // The notification icon
    }

export const updateOptions = async(options = defaultUpdateOptions) => {
  return TrackPlayer.updateOptions(options)
}

// export const setMaxCache = async size => {
//   // const currentTrack = await TrackPlayer.getCurrentTrack()
//   // if (!currentTrack) return
//   // console.log(currentTrack)
//   // const currentTime = await TrackPlayer.getPosition()
//   // const state = await TrackPlayer.getState()
//   // await stop()
//   // await TrackPlayer.destroy()
//   // await TrackPlayer.setupPlayer({ maxCacheSize: size * 1024, maxBuffer: 1000, waitForBuffer: true })
//   // await updateOptions()
//   // await TrackPlayer.seekTo(currentTime)
//   // switch (state) {
//   //   case TrackPlayer.STATE_PLAYING:
//   //   case TrackPlayer.STATE_BUFFERING:
//   //     await TrackPlayer.play()
//   //     break
//   //   default:
//   //     break
//   // }
// }

// export {
//   useProgress,
// }

export { updateMetaData, initTrackInfo } from './playList'
