import TrackPlayer, { State } from 'react-native-track-player'
import BackgroundTimer from 'react-native-background-timer'
import { defaultUrl } from '@/config'
import { NativeModules, Platform } from 'react-native'
// import { action as playerAction } from '@/store/modules/player'
import settingState from '@/store/setting/state'
import { getAccuratePosition, seekToTime } from './seek'
import { updateNowPlayingInfo } from '@/utils/nativeModules/nowPlaying'
import {
  getNativeFlacDuration,
  getNativeFlacPosition,
  getNativeFlacState,
  getNativeFlacTrackId,
  isNativeFlacActive,
  resetNativeFlacPlayback,
  shouldUseNativeFlacPlayer,
  startNativeFlacPlayback,
} from './nativeFlac'


const list: LX.Player.Track[] = []

const defaultUserAgent = 'Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Mobile Safari/537.36'
const httpRxp = /^(https?:\/\/.+|\/.+)/
const wait = async(ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const state = {
  isPlaying: false,
  prevDuration: -1,
}

const NativeTrackPlayerModule = NativeModules.TrackPlayerModule as {
  getDuration?: () => Promise<number>
}

const formatNowPlayingTitleLine = (title?: string, artist?: string) => {
  const safeTitle = title ?? 'Unknow'
  return artist ? `${safeTitle} - ${artist}` : safeTitle
}

const formatIOSNowPlayingMetadata = (metadata: {
  title?: string
  artist?: string
  artwork?: string
  duration?: number
  elapsedTime?: number
  playbackRate?: number
  lyric?: string
}) => {
  return {
    title: formatNowPlayingTitleLine(metadata.title, metadata.artist),
    artist: metadata.lyric ?? '',
    album: '',
    artwork: metadata.artwork,
    duration: metadata.duration,
    elapsedTime: metadata.elapsedTime,
    playbackRate: metadata.playbackRate,
  }
}

const formatMusicInfo = (musicInfo: LX.Player.PlayMusic) => {
  return 'progress' in musicInfo ? {
    id: musicInfo.id,
    pic: musicInfo.metadata.musicInfo.meta.picUrl,
    name: musicInfo.metadata.musicInfo.name,
    singer: musicInfo.metadata.musicInfo.singer,
    album: musicInfo.metadata.musicInfo.meta.albumName,
  } : {
    id: musicInfo.id,
    pic: musicInfo.meta.picUrl,
    name: musicInfo.name,
    singer: musicInfo.singer,
    album: musicInfo.meta.albumName,
  }
}

const buildTracks = (musicInfo: LX.Player.PlayMusic, url?: LX.Player.Track['url'], duration?: LX.Player.Track['duration']): LX.Player.Track[] => {
  const mInfo = formatMusicInfo(musicInfo)
  const track = [] as LX.Player.Track[]
  const isShowNotificationImage = settingState.setting['player.isShowNotificationImage']
  const album = mInfo.album || undefined
  const artwork = isShowNotificationImage && mInfo.pic && httpRxp.test(mInfo.pic) ? mInfo.pic : undefined
  if (url) {
    track.push({
      id: `${mInfo.id}__//${Math.random()}__//${url}`,
      url,
      title: mInfo.name || 'Unknow',
      artist: mInfo.singer || 'Unknow',
      album,
      artwork,
      userAgent: defaultUserAgent,
      musicId: mInfo.id,
      // original: { ...musicInfo },
      duration,
    })
  }
  if (!url || Platform.OS != 'ios') {
    track.push({
      id: `${mInfo.id}__//${Math.random()}__//default`,
      url: defaultUrl,
      title: mInfo.name || 'Unknow',
      artist: mInfo.singer || 'Unknow',
      album,
      artwork,
      musicId: mInfo.id,
      // original: { ...musicInfo },
      duration: 0,
    })
  }
  return track
  // console.log('buildTrack', musicInfo.name, url)
}
// const buildTrack = (musicInfo: LX.Player.PlayMusic, url: LX.Player.Track['url'], duration?: LX.Player.Track['duration']): LX.Player.Track => {
//   const mInfo = formatMusicInfo(musicInfo)
//   const isShowNotificationImage = settingState.setting['player.isShowNotificationImage']
//   const album = mInfo.album || undefined
//   const artwork = isShowNotificationImage && mInfo.pic && httpRxp.test(mInfo.pic) ? mInfo.pic : undefined
//   return url
//     ? {
//         id: `${mInfo.id}__//${Math.random()}__//${url}`,
//         url,
//         title: mInfo.name || 'Unknow',
//         artist: mInfo.singer || 'Unknow',
//         album,
//         artwork,
//         userAgent: defaultUserAgent,
//         musicId: `${mInfo.id}`,
//         original: { ...musicInfo },
//         duration,
//       }
//     : {
//         id: `${mInfo.id}__//${Math.random()}__//default`,
//         url: defaultUrl,
//         title: mInfo.name || 'Unknow',
//         artist: mInfo.singer || 'Unknow',
//         album,
//         artwork,
//         musicId: `${mInfo.id}`,
//         original: { ...musicInfo },
//         duration: 0,
//       }
// }

export const isTempTrack = (trackId: string) => /\/\/default$/.test(trackId)


export const getCurrentTrackId = async() => {
  const currentTrackIndex = await TrackPlayer.getCurrentTrack()
  return list[currentTrackIndex]?.id
}
export const getCurrentTrack = async() => {
  const currentTrackIndex = await TrackPlayer.getCurrentTrack()
  return list[currentTrackIndex]
}

const applyCurrentVolume = async() => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return
  await TrackPlayer.setVolume(settingState.setting['player.volume'])
}

const getTrackDuration = async() => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return getNativeFlacDuration()
  if (Platform.OS == 'ios' && typeof NativeTrackPlayerModule?.getDuration == 'function') {
    return NativeTrackPlayerModule.getDuration()
  }
  return TrackPlayer.getDuration()
}

export const clearTracks = () => {
  list.length = 0
  prevArtwork = undefined
  state.isPlaying = false
  state.prevDuration = -1
}

const updateCurrentTrackMetadata = async(metadata: {
  title?: string
  artist?: string
  album?: string
  artwork?: string
  duration?: number
  elapsedTime?: number
  playbackRate?: number
}) => {
  const currentTrackIndex = await TrackPlayer.getCurrentTrack().catch(() => null)
  if (currentTrackIndex != null && currentTrackIndex > -1) {
    await TrackPlayer.updateMetadataForTrack(currentTrackIndex, metadata).catch(() => {})
  }
  if (Platform.OS == 'ios') {
    const nowPlayingMetadata = {
      ...metadata,
      playbackRate: metadata.playbackRate ?? (state.isPlaying ? settingState.setting['player.playbackRate'] : 0),
    }
    if (metadata.artwork !== undefined) nowPlayingMetadata.artwork = metadata.artwork
    else if (!settingState.setting['player.isShowNotificationImage']) nowPlayingMetadata.artwork = ''
    await updateNowPlayingInfo(nowPlayingMetadata).catch(() => {})
  } else {
    await TrackPlayer.updateNowPlayingMetadata(metadata, state.isPlaying).catch(() => {})
  }
}

const ensureCurrentTrackMetadata = (metadata: {
  title?: string
  artist?: string
  album?: string
  artwork?: string
  duration?: number
  elapsedTime?: number
  playbackRate?: number
}) => {
  void (async() => {
    const targetMetadata = Platform.OS == 'ios' ? formatIOSNowPlayingMetadata(metadata) : metadata
    const delays = Platform.OS == 'ios' ? [0, 160, 420, 900] : [0]
    for (const delay of delays) {
      if (delay) await wait(delay)
      await updateCurrentTrackMetadata(targetMetadata)
    }
  })()
}

export const restoreTrack = async(track: LX.Player.Track, position: number, isPlaying: boolean) => {
  const restoredTrack = { ...track }
  await TrackPlayer.add([restoredTrack]).then(() => list.push(restoredTrack))
  const queue = await TrackPlayer.getQueue() as LX.Player.Track[]
  const trackIndex = queue.findIndex(t => t.id == restoredTrack.id)
  if (trackIndex > -1) await TrackPlayer.skip(trackIndex)
  global.lx.playerTrackId = restoredTrack.id
  if (position > 0) await seekToTime(position)
  if (isPlaying) await TrackPlayer.play()
  else await TrackPlayer.pause()
  await applyCurrentVolume()
  ensureCurrentTrackMetadata({
    title: restoredTrack.title,
    artist: restoredTrack.artist,
    album: restoredTrack.album,
    artwork: typeof restoredTrack.artwork == 'string' ? restoredTrack.artwork : undefined,
    duration: restoredTrack.duration,
    elapsedTime: position,
    playbackRate: isPlaying ? settingState.setting['player.playbackRate'] : 0,
  })
}

const resolveShouldAutoStart = (currentTrackIndex: number | null) => {
  if (currentTrackIndex != null) return true
  if (!global.lx.restorePlayInfo) return true
  global.lx.restorePlayInfo = null
  return false
}

export const updateMetaData = async(musicInfo: LX.Player.MusicInfo, isPlay: boolean, lyric?: string, force = false) => {
  if (force) {
    const duration = await getTrackDuration()
    state.prevDuration = duration
    delayUpdateMusicInfo(musicInfo, lyric)
    return
  }
  if (!force && isPlay == state.isPlaying) {
    const duration = await getTrackDuration()
    if (state.prevDuration != duration) {
      state.prevDuration = duration
      const trackInfo = await getCurrentTrack()
      if (trackInfo && musicInfo) {
        delayUpdateMusicInfo(musicInfo, lyric)
      }
    }
  } else {
    const [duration, trackInfo] = await Promise.all([getTrackDuration(), getCurrentTrack()])
    state.prevDuration = duration
    if (trackInfo && musicInfo) {
      delayUpdateMusicInfo(musicInfo, lyric)
    }
  }
}

export const initTrackInfo = async(musicInfo: LX.Player.PlayMusic, mInfo: LX.Player.MusicInfo) => {
  const tracks = buildTracks(musicInfo)
  await TrackPlayer.add(tracks).then(() => list.push(...tracks))
  const queue = await TrackPlayer.getQueue() as LX.Player.Track[]
  await TrackPlayer.skip(queue.findIndex(t => t.id == tracks[0].id))
  delayUpdateMusicInfo(mInfo)
}


const handlePlayMusic = async(musicInfo: LX.Player.PlayMusic, url: string, time: number, quality?: LX.Quality | null) => {
  const currentTrackIndex = await TrackPlayer.getCurrentTrack()
  const shouldAutoStart = resolveShouldAutoStart(currentTrackIndex)
  if (Platform.OS == 'ios' && await shouldUseNativeFlacPlayer(musicInfo, url, quality)) {
    global.lx.playerStatus.ignoreTrackPlayerLifecycle = true
    try {
      await TrackPlayer.reset().catch(async() => {
        await TrackPlayer.stop().catch(() => {})
      })
      clearTracks()
      const playbackInfo = await startNativeFlacPlayback(musicInfo, url, time, shouldAutoStart)
      global.lx.playerTrackId = getNativeFlacTrackId()
      ensureCurrentTrackMetadata({
        title: ('progress' in musicInfo ? musicInfo.metadata.musicInfo.name : musicInfo.name) ?? 'Unknow',
        artist: ('progress' in musicInfo ? musicInfo.metadata.musicInfo.singer : musicInfo.singer) ?? 'Unknow',
        album: ('progress' in musicInfo ? musicInfo.metadata.musicInfo.meta.albumName : musicInfo.meta.albumName) ?? undefined,
        artwork: 'progress' in musicInfo
          ? (typeof musicInfo.metadata.musicInfo.meta.picUrl == 'string' ? musicInfo.metadata.musicInfo.meta.picUrl : undefined)
          : (typeof musicInfo.meta.picUrl == 'string' ? musicInfo.meta.picUrl : undefined),
        duration: playbackInfo.duration,
        elapsedTime: playbackInfo.position,
        playbackRate: shouldAutoStart ? settingState.setting['player.playbackRate'] : 0,
      })
      return
    } finally {
      global.lx.playerStatus.ignoreTrackPlayerLifecycle = false
    }
  }
  if (Platform.OS == 'ios') {
    await resetNativeFlacPlayback().catch(() => {})
  }
  // console.log(tracks, time)
  const tracks = buildTracks(musicInfo, url)
  const track = tracks[0]
  let isPlaying = false
  // await updateMusicInfo(track)
  await TrackPlayer.add(tracks).then(() => list.push(...tracks))
  const queue = await TrackPlayer.getQueue() as LX.Player.Track[]
  await TrackPlayer.skip(queue.findIndex(t => t.id == track.id))
  global.lx.playerTrackId = track.id

  if (currentTrackIndex == null) {
    if (!isTempTrack(track.id as string)) {
      if (time) await seekToTime(time)
      if (!shouldAutoStart) {
        await TrackPlayer.pause()
      } else {
        await TrackPlayer.play()
        await applyCurrentVolume()
        isPlaying = true
      }
    }
  } else {
    await TrackPlayer.pause()
    if (!isTempTrack(track.id as string)) {
      await seekToTime(time)
      await TrackPlayer.play()
      await applyCurrentVolume()
      isPlaying = true
    }
  }

  if (queue.length > tracks.length) {
    const removeCount = queue.length - tracks.length
    void TrackPlayer.remove(Array(removeCount).fill(null).map((_, i) => i)).then(() => list.splice(0, list.length - removeCount))
  }
  ensureCurrentTrackMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: typeof track.artwork == 'string' ? track.artwork : undefined,
    duration: track.duration,
    elapsedTime: time,
    playbackRate: isPlaying ? settingState.setting['player.playbackRate'] : 0,
  })
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
let prevArtwork: string | undefined
const updateMetaInfo = async(mInfo: LX.Player.MusicInfo, lyric?: string) => {
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
  state.isPlaying = Platform.OS == 'ios' && isNativeFlacActive()
    ? await getNativeFlacState().then((state) => state == 'playing')
    : await TrackPlayer.getState() == State.Playing
  let artwork = isShowNotificationImage ? mInfo.pic ?? prevArtwork : undefined
  if (mInfo.pic) prevArtwork = mInfo.pic
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
    playbackRate: state.isPlaying ? settingState.setting['player.playbackRate'] : 0,
  }
  await updateCurrentTrackMetadata(metadata)
}


// 解决快速切歌导致的通知栏歌曲信息与当前播放歌曲对不上的问题
const debounceUpdateMetaInfoTools = {
  updateMetaPromise: Promise.resolve(),
  musicInfo: null as LX.Player.MusicInfo | null,
  debounce(fn: (musicInfo: LX.Player.MusicInfo, lyric?: string) => void | Promise<void>) {
    // let delayTimer = null
    let isDelayRun = false
    let timer: number | null = null
    let _musicInfo: LX.Player.MusicInfo | null = null
    let _lyric: string | undefined
    return (musicInfo: LX.Player.MusicInfo, lyric?: string) => {
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
        timer = BackgroundTimer.setTimeout(() => {
          timer = null
          let musicInfo = _musicInfo
          let lyric = _lyric
          _musicInfo = null
          _lyric = undefined
          if (!musicInfo) return
          // isDelayRun = false
          void fn(musicInfo, lyric)
        }, 500)
      } else {
        isDelayRun = true
        void fn(musicInfo, lyric)
        BackgroundTimer.setTimeout(() => {
          // delayTimer = null
          isDelayRun = false
        }, 500)
      }
    }
  },
  init() {
    return this.debounce(async(musicInfo: LX.Player.MusicInfo, lyric?: string) => {
      this.musicInfo = musicInfo
      return this.updateMetaPromise.then(() => {
        // console.log('run')
        if (this.musicInfo?.id === musicInfo.id) {
          this.updateMetaPromise = updateMetaInfo(musicInfo, lyric)
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
