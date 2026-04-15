import TrackPlayer from 'react-native-track-player'
import { defaultUrl } from '@/config'
import { NativeModules, Platform } from 'react-native'
import settingState from '@/store/setting/state'
import { seekToTime } from './seek'
import { clearNowPlayingInfo, updateNowPlayingInfo } from '@/utils/nativeModules/nowPlaying'

const list: LX.Player.Track[] = []

const defaultUserAgent = 'Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Mobile Safari/537.36'
const httpRxp = /^(https?:\/\/.+|\/.+)/
const wait = async(ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const trackPlayerState = {
  isPlaying: false,
  prevDuration: -1,
}

const NativeTrackPlayerModule = NativeModules.TrackPlayerModule as {
  getDuration?: () => Promise<number>
}

export const formatNowPlayingTitleLine = (title?: string, artist?: string) => {
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

export const formatMusicInfo = (musicInfo: LX.Player.PlayMusic) => {
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

export const buildTracks = (musicInfo: LX.Player.PlayMusic, url?: LX.Player.Track['url'], duration?: LX.Player.Track['duration']): LX.Player.Track[] => {
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
      duration: 0,
    })
  }
  return track
}

export const isTempTrack = (trackId: string) => /\/\/default$/.test(trackId)

export const getCurrentTrackId = async() => {
  const currentTrackIndex = await TrackPlayer.getCurrentTrack()
  return list[currentTrackIndex]?.id
}

export const getCurrentTrack = async() => {
  const currentTrackIndex = await TrackPlayer.getCurrentTrack()
  return list[currentTrackIndex]
}

export const applyCurrentVolume = async() => {
  await TrackPlayer.setVolume(settingState.setting['player.volume'])
}

export const getTrackDuration = async() => {
  if (Platform.OS == 'ios' && typeof NativeTrackPlayerModule?.getDuration == 'function') {
    return NativeTrackPlayerModule.getDuration()
  }
  return TrackPlayer.getDuration()
}

export const clearTracks = () => {
  list.length = 0
  prevArtwork = undefined
  trackPlayerState.isPlaying = false
  trackPlayerState.prevDuration = -1
}

export const updateCurrentTrackMetadata = async(metadata: {
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
    const nowPlayingMetadata: Parameters<typeof updateNowPlayingInfo>[0] = {
      ...metadata,
      artwork: metadata.artwork ?? '',
    }
    if (metadata.playbackRate !== undefined) nowPlayingMetadata.playbackRate = metadata.playbackRate
    await updateNowPlayingInfo(nowPlayingMetadata).catch(() => {})
  } else {
    await TrackPlayer.updateNowPlayingMetadata(metadata, trackPlayerState.isPlaying).catch(() => {})
  }
}

export const ensureCurrentTrackMetadata = (metadata: {
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
  })
}

export const initTrackInfo = async(musicInfo: LX.Player.PlayMusic, mInfo: LX.Player.MusicInfo, delayUpdateMusicInfo: (musicInfo: LX.Player.MusicInfo, lyric?: string, isPlaying?: boolean) => void) => {
  const tracks = buildTracks(musicInfo)
  await TrackPlayer.add(tracks).then(() => list.push(...tracks))
  const queue = await TrackPlayer.getQueue() as LX.Player.Track[]
  await TrackPlayer.skip(queue.findIndex(t => t.id == tracks[0].id))
  delayUpdateMusicInfo(mInfo)
}

export const loadTrackPlayerResource = async(musicInfo: LX.Player.PlayMusic, url: string, time: number, shouldAutoStart: boolean) => {
  const currentTrackIndex = await TrackPlayer.getCurrentTrack()
  const tracks = buildTracks(musicInfo, url)
  const track = tracks[0]
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
      }
    }
  } else {
    await TrackPlayer.pause()
    if (!isTempTrack(track.id as string)) {
      await seekToTime(time)
      await TrackPlayer.play()
      await applyCurrentVolume()
    }
  }

  if (queue.length > tracks.length) {
    const removeCount = queue.length - tracks.length
    void TrackPlayer.remove(Array(removeCount).fill(null).map((_, i) => i)).then(() => list.splice(0, list.length - removeCount))
  }
  return track
}

export const destroyTrackPlayerCore = async() => {
  try {
    await TrackPlayer.destroy()
  } finally {
    if (Platform.OS == 'ios') await clearNowPlayingInfo().catch(() => {})
    clearTracks()
  }
}
