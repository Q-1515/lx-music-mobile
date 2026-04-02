import {
  play as lrcPlay,
  setLyric as lrcSetLyric,
  pause as lrcPause,
  onLyricPlay as onPluginLyricPlay,
  setPlaybackRate as lrcSetPlaybackRate,
  toggleTranslation as lrcToggleTranslation,
  toggleRoma as lrcToggleRoma,
  init as lrcInit,
} from '@/plugins/lyric'
import {
  playDesktopLyric,
  setDesktopLyric,
  pauseDesktopLyric,
  setDesktopLyricPlaybackRate,
  toggleDesktopLyricTranslation,
  toggleDesktopLyricRoma,
} from '@/core/desktopLyric'
import { getPosition } from '@/plugins/player/utils'
import playerState from '@/store/player/state'
import { getLyricPayload } from '@/core/lyricInfo'
// import settingState from '@/store/setting/state'

const getReliableLyricPosition = async() => {
  const progressPosition = Math.max(playerState.progress.nowPlayTime, 0)
  const playerPosition = await getPosition().catch(() => progressPosition)

  // Right after switching songs, progress belongs to the new song and is reset
  // immediately, while native/player position may still transiently report the
  // previous song. In that window, always trust the new track progress.
  if (progressPosition <= 1) {
    if (playerPosition > 5) return progressPosition
    return Math.max(progressPosition, 0)
  }
  if (playerPosition <= 0) return progressPosition

  if (Math.abs(playerPosition - progressPosition) > 2) return progressPosition
  return playerPosition
}

/**
 * init lyric
 */
export const init = async() => {
  return lrcInit()
}

/**
 * set lyric
 * @param lyric lyric str
 * @param translation lyric translation
 */
const handleSetLyric = async(lyric: string, translation = '', romalrc = '') => {
  lrcSetLyric(lyric, translation, romalrc)
  await setDesktopLyric(lyric, translation, romalrc)
}

/**
 * play lyric
 * @param time play time
 */
export const handlePlay = (time: number) => {
  lrcPlay(time)
  void playDesktopLyric(time)
}

/**
 * pause lyric
 */
export const pause = () => {
  lrcPause()
  void pauseDesktopLyric()
}

export const onLyricPlay = onPluginLyricPlay

/**
 * stop lyric
 */
export const stop = () => {
  void handleSetLyric('')
}

/**
 * set playback rate
 * @param playbackRate playback rate
 */
export const setPlaybackRate = async(playbackRate: number) => {
  lrcSetPlaybackRate(playbackRate)
  await setDesktopLyricPlaybackRate(playbackRate)
  if (playerState.isPlay) {
    setTimeout(() => {
      void getReliableLyricPosition().then((position) => {
        handlePlay(position * 1000)
      })
    })
  }
}

/**
 * toggle show translation
 * @param isShowTranslation is show translation
 */
export const toggleTranslation = async(isShowTranslation: boolean) => {
  lrcToggleTranslation(isShowTranslation)
  await toggleDesktopLyricTranslation(isShowTranslation)
  if (playerState.isPlay) play()
}

/**
 * toggle show roma lyric
 * @param isShowLyricRoma is show roma lyric
 */
export const toggleRoma = async(isShowLyricRoma: boolean) => {
  lrcToggleRoma(isShowLyricRoma)
  await toggleDesktopLyricRoma(isShowLyricRoma)
  if (playerState.isPlay) play()
}

export const play = () => {
  void getReliableLyricPosition().then((position) => {
    handlePlay(position * 1000)
  })
}

export const seek = (time: number) => {
  pause()
  setTimeout(() => {
    handlePlay(time * 1000)
    if (!playerState.isPlay) {
      setTimeout(() => {
        pause()
      })
    }
  }, 60)
}


export const setLyric = async() => {
  if (!playerState.musicInfo.id) return
  const { lyric, tlrc, rlrc } = getLyricPayload(playerState.musicInfo)
  if (lyric) {
    await handleSetLyric(lyric, tlrc, rlrc)
  }

  if (playerState.isPlay) play()
}
