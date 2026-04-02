import { useEffect, useState } from 'react'
import Lyric, { type Lines } from 'lrc-file-parser'
import LxLyricPlayer, { type LxLyricLine } from './lxLyricPlayer'
// import { getStore, subscribe } from '@/store'
export type Line = (Lines[number] & { rawText?: string, words?: Array<{ startTime: number, duration: number, text: string }> }) | LxLyricLine
type PlayerLines = Line[]
type PlayHook = (line: number, text: string, wordIndex: number, wordProgress: number) => void
type SetLyricHook = (lines: PlayerLines) => void

const lxLyricTextRxp = /<\d+,\d+>/

const lrcTools = {
  isInited: false,
  lrc: null as Lyric | null,
  lxLrc: null as LxLyricPlayer | null,
  useLxPlayer: false,
  currentLineData: { line: 0, text: '', wordIndex: -1, wordProgress: 0 },
  currentLines: [] as PlayerLines,
  playHooks: [] as PlayHook[],
  setLyricHooks: [] as SetLyricHook[],
  isPlay: false,
  isShowTranslation: false,
  isShowRoma: false,
  lyricText: '',
  translationText: '' as string | null | undefined,
  romaText: '' as string | null | undefined,
  init() {
    if (this.isInited) return
    this.isInited = true
    this.lrc = new Lyric({
      onPlay: this.onPlay.bind(this),
      onSetLyric: this.onSetLyric.bind(this),
      offset: 100, // offset time(ms), default is 150 ms
    })
    this.lxLrc = new LxLyricPlayer({
      onPlay: this.onPlay.bind(this),
      onSetLyric: this.onSetLyric.bind(this),
      offset: 100,
    })
  },
  onPlay(line: number, text: string, wordIndex: number = -1, wordProgress: number = 0) {
    this.currentLineData.line = line
    // console.log(line)
    this.currentLineData.text = text
    this.currentLineData.wordIndex = wordIndex
    this.currentLineData.wordProgress = wordProgress
    for (const hook of this.playHooks) hook(line, text, wordIndex, wordProgress)
  },
  onSetLyric(lines: PlayerLines) {
    this.currentLines = lines
    this.currentLineData.line = 0
    this.currentLineData.text = ''
    this.currentLineData.wordIndex = -1
    this.currentLineData.wordProgress = 0
    for (const hook of this.playHooks) hook(-1, '', -1, 0)
    for (const hook of this.setLyricHooks) hook(lines)
  },
  addPlayHook(hook: PlayHook) {
    this.playHooks.push(hook)
    hook(this.currentLineData.line, this.currentLineData.text, this.currentLineData.wordIndex, this.currentLineData.wordProgress)
  },
  removePlayHook(hook: PlayHook) {
    this.playHooks.splice(this.playHooks.indexOf(hook), 1)
  },
  addSetLyricHook(hook: SetLyricHook) {
    this.setLyricHooks.push(hook)
    hook(this.currentLines)
  },
  removeSetLyricHook(hook: SetLyricHook) {
    this.setLyricHooks.splice(this.setLyricHooks.indexOf(hook), 1)
  },
  stopPlayers() {
    this.lrc?.pause()
    this.lxLrc?.pause()
  },
  setLyric() {
    this.stopPlayers()
    const extendedLyrics = [] as string[]
    if (this.isShowTranslation && this.translationText) extendedLyrics.push(this.translationText)
    if (this.isShowRoma && this.romaText) extendedLyrics.push(this.romaText)
    this.useLxPlayer = lxLyricTextRxp.test(this.lyricText)
    if (this.useLxPlayer) this.lxLrc!.setLyric(this.lyricText, extendedLyrics)
    else this.lrc!.setLyric(this.lyricText, extendedLyrics)
  },
}


export const init = async() => {
  lrcTools.init()
}

export const setLyric = (lyric: string, translation?: string, romalrc?: string) => {
  lrcTools.isPlay = false
  lrcTools.lyricText = lyric
  lrcTools.translationText = translation
  lrcTools.romaText = romalrc
  lrcTools.setLyric()
}
export const setPlaybackRate = (playbackRate: number) => {
  if (lrcTools.useLxPlayer) lrcTools.lxLrc!.setPlaybackRate(playbackRate)
  else lrcTools.lrc!.setPlaybackRate(playbackRate)
}
export const toggleTranslation = (isShow: boolean) => {
  lrcTools.isShowTranslation = isShow
  if (!lrcTools.lyricText) return
  lrcTools.setLyric()
}
export const toggleRoma = (isShow: boolean) => {
  lrcTools.isShowRoma = isShow
  if (!lrcTools.lyricText) return
  lrcTools.setLyric()
}
export const play = (time: number) => {
  // console.log(time)
  lrcTools.isPlay = true
  if (lrcTools.useLxPlayer) lrcTools.lxLrc!.play(time)
  else lrcTools.lrc!.play(time)
}
export const pause = () => {
  // console.log('pause')
  lrcTools.isPlay = false
  lrcTools.stopPlayers()
}

export const onLyricPlay = (hook: PlayHook) => {
  lrcTools.addPlayHook(hook)
  return () => {
    lrcTools.removePlayHook(hook)
  }
}

// on lyric play hook
export const useLrcPlay = (autoUpdate = true) => {
  const [lrcInfo, setLrcInfo] = useState(lrcTools.currentLineData)
  useEffect(() => {
    if (!autoUpdate) return
    const setLrcCallback: SetLyricHook = () => {
      setLrcInfo({ line: 0, text: '', wordIndex: -1, wordProgress: 0 })
    }
    const playCallback: PlayHook = (line, text, wordIndex, wordProgress) => {
      setLrcInfo({ line, text, wordIndex, wordProgress })
    }
    lrcTools.addSetLyricHook(setLrcCallback)
    lrcTools.addPlayHook(playCallback)
    setLrcInfo(lrcTools.currentLineData)
    return () => {
      lrcTools.removeSetLyricHook(setLrcCallback)
      lrcTools.removePlayHook(playCallback)
    }
  }, [autoUpdate])

  return lrcInfo
}

// on lyric set hook
export const useLrcSet = () => {
  const [lines, setLines] = useState<PlayerLines>(lrcTools.currentLines)
  useEffect(() => {
    const callback: SetLyricHook = (lines) => {
      setLines(lines)
    }
    lrcTools.addSetLyricHook(callback)
    return () => { lrcTools.removeSetLyricHook(callback) }
  }, [])

  return lines
}

