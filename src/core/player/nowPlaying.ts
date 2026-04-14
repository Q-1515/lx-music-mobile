import { getPosition, updateMetaData } from '@/plugins/player'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { pauseNowPlaying, playNowPlaying, stopNowPlaying } from '@/utils/nativeModules/nowPlaying'
import { log } from '@/utils/log'

const getElapsedTime = async() => getPosition().catch(() => playerState.progress.nowPlayTime)

export const syncNowPlayingState = async(type: 'play' | 'pause' | 'stop') => {
  const elapsedTime = type == 'stop' ? 0 : await getElapsedTime()
  log.info('[NowPlaying] sync state', {
    type,
    elapsedTime,
    isPlay: playerState.isPlay,
    musicId: playerState.musicInfo.id,
    playbackRate: settingState.setting['player.playbackRate'],
  })

  if (type == 'play') {
    await playNowPlaying({
      elapsedTime,
      playbackRate: settingState.setting['player.playbackRate'],
    }).catch(() => {})
    return
  }

  if (type == 'pause') {
    await pauseNowPlaying({
      elapsedTime,
      playbackRate: 0,
    }).catch(() => {})
    return
  }

  await stopNowPlaying({
    elapsedTime,
    playbackRate: 0,
  }).catch(() => {})
}

export const syncNowPlayingMetadata = (force = false) => {
  if (!playerState.playMusicInfo.musicInfo) return
  log.info('[NowPlaying] sync metadata', {
    force,
    isPlay: playerState.isPlay,
    musicId: playerState.musicInfo.id,
    lyric: playerState.lastLyric,
  })
  void updateMetaData(playerState.musicInfo, playerState.isPlay, playerState.lastLyric, force)
}
