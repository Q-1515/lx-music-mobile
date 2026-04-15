import TrackPlayer from 'react-native-track-player'
import { Platform } from 'react-native'
import BackgroundTimer from 'react-native-background-timer'
import { updateMetaData } from './playList'
import { initUnifiedPlayerEngine, onUnifiedPlayerEvent } from './engine'
import { getNativeFlacTrackId, setNativeFlacRate, setNativeFlacVolume } from './nativeFlac'
import { getPosition, isEmpty, setStop } from './utils'
import { exitApp } from '@/core/common'
import { getCurrentStreamInfo, playNext, setMusicUrl } from '@/core/player/player'
import { setStatusText } from '@/core/player/playStatus'
import { isActive } from '@/utils/tools'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { setNowPlayTime } from '@/core/player/progress'
import { log } from '@/utils/log'

let isInitialized = false

const handleExitApp = async(reason: string) => {
  global.lx.isPlayedStop = false
  exitApp(reason)
}

export const initUnifiedPlayerController = () => {
  if (isInitialized) return
  initUnifiedPlayerEngine()

  let retryNum = 0
  let prevTimeoutId: string | null = null
  let loadingTimeout: number | null = null
  let delayNextTimeout: number | null = null

  const clearLoadingTimeout = () => {
    if (!loadingTimeout) return
    BackgroundTimer.clearTimeout(loadingTimeout)
    loadingTimeout = null
  }

  const startLoadingTimeout = () => {
    clearLoadingTimeout()
    loadingTimeout = BackgroundTimer.setTimeout(() => {
      if (prevTimeoutId == playerState.musicInfo.id) {
        prevTimeoutId = null
        void playNext(true)
      } else {
        prevTimeoutId = playerState.musicInfo.id
        if (playerState.playMusicInfo.musicInfo) setMusicUrl(playerState.playMusicInfo.musicInfo, true)
      }
    }, 25000)
  }

  const clearDelayNextTimeout = () => {
    if (!delayNextTimeout) return
    BackgroundTimer.clearTimeout(delayNextTimeout)
    delayNextTimeout = null
  }

  const addDelayNextTimeout = () => {
    clearDelayNextTimeout()
    delayNextTimeout = BackgroundTimer.setTimeout(() => {
      if (global.lx.isPlayedStop) {
        setStatusText('')
        return
      }
      void playNext(true)
    }, 5000)
  }

  const resetRecoveryState = () => {
    retryNum = 0
    prevTimeoutId = null
    clearDelayNextTimeout()
    clearLoadingTimeout()
  }

  const handleControllerError = () => {
    if (!playerState.musicInfo.id) return
    clearLoadingTimeout()
    if (global.lx.isPlayedStop) return
    const currentStreamInfo = getCurrentStreamInfo()
    log.warn('player handleError', {
      currentMusicId: playerState.musicInfo.id,
      playMusicId: playerState.playMusicInfo.musicInfo?.id ?? null,
      trackId: global.lx.playerTrackId,
      gettingUrlId: global.lx.gettingUrlId,
      retryNum,
      streamQuality: currentStreamInfo?.quality ?? null,
      streamUrl: currentStreamInfo?.url ?? '',
      isPlay: playerState.isPlay,
    })
    if (playerState.playMusicInfo.musicInfo && retryNum < 2) {
      const musicInfo = playerState.playMusicInfo.musicInfo
      void getPosition().then((position) => {
        if (position) setNowPlayTime(position)
      }).finally(() => {
        if (playerState.playMusicInfo.musicInfo !== musicInfo) return
        retryNum++
        setMusicUrl(playerState.playMusicInfo.musicInfo, true)
        setStatusText(global.i18n.t('player__refresh_url'))
      })
      return
    }
    if (!isEmpty()) void setStop()
    if (isActive()) {
      setStatusText(global.i18n.t('player__error'))
      setTimeout(addDelayNextTimeout)
    } else {
      void playNext(true)
    }
  }

  onUnifiedPlayerEvent(async(event) => {
    if (
      event.driver == 'trackPlayer' &&
      (
        global.lx.gettingUrlId ||
        (isEmpty(global.lx.playerTrackId) && /\/\/default\/\/restorePlay$/.test(global.lx.playerTrackId))
      )
    ) return
    switch (event.type) {
      case 'state':
        switch (event.state) {
          case 'loading':
            if (!global.lx.isPlayedStop && playerState.musicInfo.id) startLoadingTimeout()
            global.app_event.playerLoadstart()
            setStatusText(global.i18n.t('player__loading'))
            break
          case 'buffering':
            if (!global.lx.isPlayedStop && playerState.musicInfo.id) startLoadingTimeout()
            global.app_event.pause()
            global.app_event.playerWaiting()
            setStatusText(global.i18n.t('player__buffering'))
            break
          case 'playing':
            clearLoadingTimeout()
            setStatusText('')
            if (event.driver == 'nativeFlac') {
              global.lx.playerTrackId = getNativeFlacTrackId()
              void setNativeFlacVolume(settingState.setting['player.volume'])
              void setNativeFlacRate(settingState.setting['player.playbackRate'])
            } else if (Platform.OS == 'ios') {
              void TrackPlayer.setVolume(settingState.setting['player.volume'])
            }
            if (Platform.OS == 'ios' && playerState.musicInfo.id) {
              // Refresh duration/elapsed metadata after playback actually starts so the
              // iOS lockscreen can render an active progress bar.
              void updateMetaData(playerState.musicInfo, true, playerState.lastLyric, true)
            }
            global.app_event.playerPlaying()
            global.app_event.play()
            break
          case 'paused':
          case 'stopped':
          case 'idle':
            clearLoadingTimeout()
            if (event.driver == 'nativeFlac' && event.state != 'paused') global.lx.playerTrackId = ''
            global.app_event.playerPause()
            global.app_event.pause()
            break
        }
        if (global.lx.isPlayedStop) void handleExitApp('Timeout Exit')
        break
      case 'error':
        if (event.driver == 'trackPlayer') {
          log.error('playback-error', {
            err: event.error,
            currentMusicId: playerState.musicInfo.id,
            playMusicId: playerState.playMusicInfo.musicInfo?.id ?? null,
            trackId: global.lx.playerTrackId,
            gettingUrlId: global.lx.gettingUrlId,
            isPlay: playerState.isPlay,
          })
        } else {
          log.error('native flac playback-error', {
            message: event.error?.message,
            currentMusicId: playerState.musicInfo.id,
            playMusicId: playerState.playMusicInfo.musicInfo?.id ?? null,
            trackId: global.lx.playerTrackId,
            gettingUrlId: global.lx.gettingUrlId,
          })
        }
        global.app_event.error()
        global.app_event.playerError()
        handleControllerError()
        break
      case 'trackChanged':
        global.lx.playerTrackId = event.trackId
        log.info('playback-track-changed', {
          info: event.info,
          currentMusicId: playerState.musicInfo.id,
          playMusicId: playerState.playMusicInfo.musicInfo?.id ?? null,
          trackId: global.lx.playerTrackId,
        })
        if (event.info?.track == null) return
        if (global.lx.isPlayedStop) return handleExitApp('Timeout Exit')
        if (Platform.OS == 'ios' && event.driver == 'trackPlayer') {
          void TrackPlayer.setVolume(settingState.setting['player.volume'])
        }
        if (Platform.OS != 'ios' && event.driver == 'trackPlayer' && isEmpty()) {
          await TrackPlayer.pause()
          global.app_event.playerPause()
          global.app_event.pause()
          global.app_event.playerEnded()
          global.app_event.playerEmptied()
          clearDelayNextTimeout()
          clearLoadingTimeout()
        }
        break
      case 'ended':
        global.lx.playerTrackId = ''
        global.app_event.playerPause()
        global.app_event.pause()
        global.app_event.playerEnded()
        global.app_event.playerEmptied()
        clearDelayNextTimeout()
        clearLoadingTimeout()
        break
    }
  })

  global.app_event.on('musicToggled', resetRecoveryState)
  isInitialized = true
}
