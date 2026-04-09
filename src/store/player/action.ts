import { arrPush, arrUnshift, formatPlayTime2 } from '@/utils'
import state from './state'

type PlayerMusicInfoKeys = keyof LX.Player.MusicInfo
const musicInfoKeys: PlayerMusicInfoKeys[] = Object.keys(state.musicInfo) as PlayerMusicInfoKeys[]
const calcProgress = (currentTime: number, totalTime: number) => {
  if (!totalTime) return 0
  const progress = currentTime / totalTime
  if (progress < 0) return 0
  if (progress > 1) return 1
  return progress
}

export default {
  updatePlayIndex(playIndex: number, playerPlayIndex: number) {
    state.playInfo.playIndex = playIndex
    state.playInfo.playerPlayIndex = playerPlayIndex

    global.state_event.playInfoChanged({ ...state.playInfo })
  },
  setPlayListId(playerListId: string | null) {
    state.playInfo.playerListId = playerListId

    global.state_event.playInfoChanged({ ...state.playInfo })
  },
  setPlayMusicInfo(listId: string | null, musicInfo: LX.Download.ListItem | LX.Music.MusicInfo | null, isTempPlay: boolean = false) {
    state.playMusicInfo = { listId, musicInfo, isTempPlay }

    global.state_event.playMusicInfoChanged(state.playMusicInfo)
  },
  setMusicInfo(_musicInfo: Partial<LX.Player.MusicInfo>) {
    for (const key of musicInfoKeys) {
      const val = _musicInfo[key]
      if (val !== undefined) {
        // @ts-expect-error
        state.musicInfo[key] = val
      }
    }

    global.state_event.playerMusicInfoChanged({ ...state.musicInfo })
  },
  setIsPlay(isPlay: boolean) {
    state.isPlay = isPlay

    global.state_event.playStateChanged(isPlay)
  },
  setStatusText(statusText: string) {
    state.statusText = statusText
    global.state_event.playStateTextChanged(statusText)
  },
  setNowPlayTime(time: number) {
    state.progress.nowPlayTime = time
    state.progress.nowPlayTimeStr = formatPlayTime2(time)
    state.progress.progress = calcProgress(time, state.progress.maxPlayTime)

    global.state_event.playProgressChanged({ ...state.progress })
  },
  setMaxplayTime(time: number) {
    state.progress.maxPlayTime = time
    state.progress.maxPlayTimeStr = formatPlayTime2(time)
    state.progress.progress = calcProgress(state.progress.nowPlayTime, time)

    global.state_event.playProgressChanged({ ...state.progress })
  },
  setProgress(currentTime: number, totalTime: number) {
    state.progress.nowPlayTime = currentTime
    state.progress.nowPlayTimeStr = formatPlayTime2(currentTime)
    state.progress.maxPlayTime = totalTime
    state.progress.maxPlayTimeStr = formatPlayTime2(totalTime)
    state.progress.progress = calcProgress(currentTime, totalTime)

    global.state_event.playProgressChanged({ ...state.progress })
  },
  addPlayedList(info: LX.Player.PlayMusicInfo) {
    if (state.playedList.some(m => m.musicInfo.id == info.musicInfo.id)) return
    state.playedList.push(info)

    global.state_event.playPlayedListChanged({ ...state.playedList })
  },
  removePlayedList(index: number) {
    state.playedList.splice(index, 1)

    global.state_event.playPlayedListChanged({ ...state.playedList })
  },
  clearPlayedList() {
    state.playedList = []

    global.state_event.playPlayedListChanged({ ...state.playedList })
  },
  addTempPlayList(list: LX.Player.TempPlayListItem[]) {
    const topList: LX.Player.PlayMusicInfo[] = []
    const bottomList = list.filter(({ isTop, ...musicInfo }) => {
      if (isTop) {
        topList.push({
          musicInfo: musicInfo.musicInfo,
          listId: musicInfo.listId,
          isTempPlay: true,
        })
        return false
      }
      return true
    })
    if (topList.length) arrUnshift(state.tempPlayList, topList)
    if (bottomList.length) arrPush(state.tempPlayList, bottomList.map(({ musicInfo, listId }) => ({ musicInfo, listId, isTempPlay: true })))

    global.state_event.playTempPlayListChanged({ ...state.tempPlayList })
  },
  removeTempPlayList(index: number) {
    state.tempPlayList.splice(index, 1)

    global.state_event.playTempPlayListChanged({ ...state.tempPlayList })
  },
  clearTempPlayeList() {
    state.tempPlayList = []

    global.state_event.playTempPlayListChanged({ ...state.tempPlayList })
  },
  setLoadErrorPicUrl(url: string) {
    state.loadErrorPicUrl = url
  },
  setLastLyric(lrc?: string) {
    state.lastLyric = lrc
  },
}
