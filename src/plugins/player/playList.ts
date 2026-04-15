import BackgroundTimer from 'react-native-background-timer'
import { Platform } from 'react-native'
import settingState from '@/store/setting/state'
import { getAccuratePosition } from './seek'
import {
  getNativeFlacPosition,
  isNativeFlacActive,
} from './nativeFlac'
import playerState from '@/store/player/state'
import { getTimelineDuration } from '@/core/player/timeline'
import {
  formatNowPlayingTitleLine,
  getCurrentTrack,
  getTrackDuration,
  initTrackInfo as handleInitTrackInfo,
  restoreTrack,
  trackPlayerState as state,
  updateCurrentTrackMetadata,
} from './trackPlayerCore'
import { loadPlaybackResource } from './engine/resourceLoader'

export { getCurrentTrack, restoreTrack }
export { state }

const resolveMetadataDuration = (duration: number) => {
  if (duration > 0) return duration
  if (playerState.progress.maxPlayTime > 0) return playerState.progress.maxPlayTime
  return getTimelineDuration(playerState.playMusicInfo.musicInfo, duration)
}

export const updateMetaData = async(musicInfo: LX.Player.MusicInfo, isPlay: boolean, lyric?: string, force = false) => {
  const prevIsPlaying = state.isPlaying
  state.isPlaying = isPlay
  if (force) {
    const duration = resolveMetadataDuration(await getTrackDuration())
    state.prevDuration = duration
    delayUpdateMusicInfo(musicInfo, lyric, isPlay)
    return
  }
  if (!force && isPlay == prevIsPlaying) {
    const duration = resolveMetadataDuration(await getTrackDuration())
    if (state.prevDuration != duration) {
      state.prevDuration = duration
      const trackInfo = await getCurrentTrack()
      if (trackInfo && musicInfo) {
        delayUpdateMusicInfo(musicInfo, lyric, isPlay)
      }
    }
  } else {
    const [duration, trackInfo] = await Promise.all([getTrackDuration(), getCurrentTrack()])
    state.prevDuration = resolveMetadataDuration(duration)
    if (trackInfo && musicInfo) {
      delayUpdateMusicInfo(musicInfo, lyric, isPlay)
    }
  }
}

export const initTrackInfo = async(musicInfo: LX.Player.PlayMusic, mInfo: LX.Player.MusicInfo) => {
  await handleInitTrackInfo(musicInfo, mInfo, delayUpdateMusicInfo)
}

const handlePlayMusic = async(musicInfo: LX.Player.PlayMusic, url: string, time: number, quality?: LX.Quality | null) => {
  await loadPlaybackResource({ musicInfo, url, time, quality })
}
let playPromise = Promise.resolve()
let actionId = Math.random()
export const playMusic = (musicInfo: LX.Player.PlayMusic, url: string, time: number, quality?: LX.Quality | null) => {
  const id = actionId = Math.random()
  void playPromise.finally(() => {
    if (id != actionId) return
    playPromise = handlePlayMusic(musicInfo, url, time, quality).catch((err: Error & { lxHandled?: boolean }) => {
      console.log(err)
      if (!err?.lxHandled) {
        global.app_event.error()
        global.app_event.playerError()
      }
    })
  })
}

// let musicId = null
// let duration = 0
const updateMetaInfo = async(mInfo: LX.Player.MusicInfo, lyric?: string, isPlaying = state.isPlaying) => {
  console.log('updateMetaInfo', lyric)
  const isShowNotificationImage = settingState.setting['player.isShowNotificationImage']
  // const mInfo = formatMusicInfo(musicInfo)
  // console.log('+++++updateMusicPic+++++', track.artwork, track.duration)

  // if (track.musicId == musicId) {
  //   if (global.playInfo.musicInfo.img != null) artwork = global.playInfo.musicInfo.img
  //   if (track.duration != null) duration = global.playInfo.duration
  // } else {
  //   musicId = track.musicId
  //   artwork = global.playInfo.musicInfo.img
  //   duration = global.playInfo.duration || 0
  // }
  // console.log('+++++updateMetaInfo+++++', mInfo.name)
  state.isPlaying = isPlaying
  let artwork = isShowNotificationImage ? mInfo.pic ?? undefined : undefined
  let name: string
  let singer: string
  let album: string | undefined
  if (Platform.OS == 'ios') {
    name = formatNowPlayingTitleLine(mInfo.name ?? 'Unknow', mInfo.singer ?? '')
    singer = lyric ?? ''
    album = ''
  } else if (!state.isPlaying || lyric == null) {
    name = mInfo.name ?? 'Unknow'
    singer = mInfo.singer ?? 'Unknow'
    album = mInfo.album ?? undefined
  } else {
    name = lyric
    singer = `${mInfo.name}${mInfo.singer ? ` - ${mInfo.singer}` : ''}`
    album = mInfo.album ?? undefined
  }
  const metadata = {
    title: name,
    artist: singer,
    album,
    artwork,
    duration: state.prevDuration || 0,
    elapsedTime: isNativeFlacActive()
      ? await getNativeFlacPosition().catch(() => 0)
      : await getAccuratePosition().catch(() => 0),
  }
  await updateCurrentTrackMetadata(metadata)
}


// 解决快速切歌导致的通知栏歌曲信息与当前播放歌曲对不上的问题
const debounceUpdateMetaInfoTools = {
  updateMetaPromise: Promise.resolve(),
  musicInfo: null as LX.Player.MusicInfo | null,
  debounce(fn: (musicInfo: LX.Player.MusicInfo, lyric?: string, isPlaying?: boolean) => void | Promise<void>) {
    // let delayTimer = null
    let isDelayRun = false
    let timer: number | null = null
    let _musicInfo: LX.Player.MusicInfo | null = null
    let _lyric: string | undefined
    let _isPlaying: boolean | undefined
    return (musicInfo: LX.Player.MusicInfo, lyric?: string, isPlaying?: boolean) => {
      // console.log('debounceUpdateMetaInfoTools', musicInfo)
      if (timer) {
        BackgroundTimer.clearTimeout(timer)
        timer = null
      }
      // if (delayTimer) {
      //   BackgroundTimer.clearTimeout(delayTimer)
      //   delayTimer = null
      // }
      if (isDelayRun) {
        _musicInfo = musicInfo
        _lyric = lyric
        _isPlaying = isPlaying
        timer = BackgroundTimer.setTimeout(() => {
          timer = null
          let musicInfo = _musicInfo
          let lyric = _lyric
          let isPlaying = _isPlaying
          _musicInfo = null
          _lyric = undefined
          _isPlaying = undefined
          if (!musicInfo) return
          // isDelayRun = false
          void fn(musicInfo, lyric, isPlaying)
        }, 500)
      } else {
        isDelayRun = true
        void fn(musicInfo, lyric, isPlaying)
        BackgroundTimer.setTimeout(() => {
          // delayTimer = null
          isDelayRun = false
        }, 500)
      }
    }
  },
  init() {
    return this.debounce(async(musicInfo: LX.Player.MusicInfo, lyric?: string, isPlaying?: boolean) => {
      this.musicInfo = musicInfo
      return this.updateMetaPromise.then(() => {
        // console.log('run')
        if (this.musicInfo?.id === musicInfo.id) {
          this.updateMetaPromise = updateMetaInfo(musicInfo, lyric, isPlaying)
        }
      })
    })
  },
}

export const delayUpdateMusicInfo = debounceUpdateMetaInfoTools.init()

// export const delayUpdateMusicInfo = ((fn, delay = 800) => {
//   let delayTimer = null
//   let isDelayRun = false
//   let timer = null
//   let _track = null
//   return track => {
//     _track = track
//     if (timer) {
//       BackgroundTimer.clearTimeout(timer)
//       timer = null
//     }
//     if (isDelayRun) {
//       if (delayTimer) {
//         BackgroundTimer.clearTimeout(delayTimer)
//         delayTimer = null
//       }
//       timer = BackgroundTimer.setTimeout(() => {
//         timer = null
//         let track = _track
//         _track = null
//         isDelayRun = false
//         fn(track)
//       }, delay)
//     } else {
//       isDelayRun = true
//       fn(track)
//       delayTimer = BackgroundTimer.setTimeout(() => {
//         delayTimer = null
//         isDelayRun = false
//       }, 500)
//     }
//   }
// })(track => {
//   console.log('+++++delayUpdateMusicPic+++++', track.artwork)
//   updateMetaInfo(track)
// })
