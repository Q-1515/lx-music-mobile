export interface LxLyricWord {
  startTime: number
  duration: number
  text: string
}

export interface LxLyricLine {
  time: number
  text: string
  rawText: string
  extendedLyrics: string[]
  words: LxLyricWord[]
}

export interface LxLyricPlayState {
  line: number
  text: string
  wordIndex: number
}

const noop = () => {}
const timeFieldExp = /^(?:\[[\d:.]+\])+/g
const timeExp = /\d{1,3}(:\d{1,3}){0,2}(?:\.\d{1,3})/g
const tagRegMap = {
  title: 'ti',
  artist: 'ar',
  album: 'al',
  offset: 'offset',
  by: 'by',
} as const
const wordTimeExp = /<(-?\d+),(-?\d+)>([^<]*)/g

const tRxp1 = /^0+(\d+)/
const tRxp2 = /:0+(\d+)/g
const tRxp3 = /\.0+(\d+)/

const formatTimeLabel = (label: string) => {
  return label.replace(tRxp1, '$1')
    .replace(tRxp2, ':$1')
    .replace(tRxp3, '.$1')
}

const parseLineWords = (text: string) => {
  const words: LxLyricWord[] = []
  let plainText = ''
  let match: RegExpExecArray | null
  while ((match = wordTimeExp.exec(text)) != null) {
    const word = match[3] ?? ''
    words.push({
      startTime: parseInt(match[1]),
      duration: parseInt(match[2]),
      text: word,
    })
    plainText += word
  }
  wordTimeExp.lastIndex = 0
  return {
    words,
    text: words.length ? plainText : text,
  }
}

const parseExtendedLyric = (lrcLinesMap: Record<string, LxLyricLine>, extendedLyric: string) => {
  const extendedLines = extendedLyric.split(/\r\n|\n|\r/)
  for (const rawLine of extendedLines) {
    const line = rawLine.trim()
    const result = timeFieldExp.exec(line)
    if (!result) continue

    const timeField = result[0]
    const text = line.replace(timeFieldExp, '').trim()
    if (!text) continue

    const times = timeField.match(timeExp)
    if (times == null) continue
    for (let time of times) {
      time = formatTimeLabel(time)
      const targetLine = lrcLinesMap[time]
      if (targetLine) targetLine.extendedLyrics.push(text)
    }
  }
}

const getNow = () => Date.now()

export default class LxLyricPlayer {
  lyric = ''
  extendedLyrics: string[] = []
  tags: Record<string, string | number> = {}
  lines: LxLyricLine[] = []
  onPlay: (line: number, text: string, wordIndex: number) => void
  onSetLyric: (lines: LxLyricLine[]) => void
  isPlay = false
  curLineNum = 0
  curWordIndex = -1
  maxLine = 0
  offset = 100
  private _performanceTime = 0
  private _startTime = 0
  private _rate = 1
  private timeoutId: ReturnType<typeof setTimeout> | null = null

  constructor({
    lyric = '',
    extendedLyrics = [],
    offset = 100,
    playbackRate = 1,
    onPlay = noop,
    onSetLyric = noop,
  }: {
    lyric?: string
    extendedLyrics?: string[]
    offset?: number
    playbackRate?: number
    onPlay?: (line: number, text: string, wordIndex: number) => void
    onSetLyric?: (lines: LxLyricLine[]) => void
  } = {}) {
    this.lyric = lyric
    this.extendedLyrics = extendedLyrics
    this.offset = offset
    this._rate = playbackRate
    this.onPlay = onPlay
    this.onSetLyric = onSetLyric
  }

  private clearTimer() {
    if (this.timeoutId == null) return
    clearTimeout(this.timeoutId)
    this.timeoutId = null
  }

  private getLineEndTime(index: number) {
    const line = this.lines[index]
    if (!line) return 0
    const lastWord = line.words.at(-1)
    if (lastWord) return line.time + lastWord.startTime + lastWord.duration
    const nextLine = this.lines[index + 1]
    if (nextLine) return nextLine.time - 30
    return line.time + 3000
  }

  private getWordIndex(lineIndex: number, currentTime: number) {
    const line = this.lines[lineIndex]
    if (!line || !line.words.length) return -1
    const elapsed = currentTime - line.time
    if (elapsed < 0) return -1
    for (let i = 0; i < line.words.length; i++) {
      const word = line.words[i]
      if (elapsed < word.startTime) return Math.max(i - 1, -1)
      if (elapsed <= word.startTime + word.duration) return i
    }
    return line.words.length - 1
  }

  private emitState(currentTime: number) {
    if (!this.lines.length) {
      if (this.curLineNum != -1 || this.curWordIndex != -1) {
        this.curLineNum = -1
        this.curWordIndex = -1
        this.onPlay(-1, '', -1)
      }
      return
    }
    const lineIndex = this.findCurLineNum(currentTime)
    const wordIndex = this.getWordIndex(lineIndex, currentTime)
    if (this.curLineNum == lineIndex && this.curWordIndex == wordIndex) return
    this.curLineNum = lineIndex
    this.curWordIndex = wordIndex
    this.onPlay(lineIndex, this.lines[lineIndex]?.text ?? '', wordIndex)
  }

  private tick() {
    if (!this.isPlay) return
    const currentTime = this.currentTime()
    this.emitState(currentTime)
    if (this.maxLine >= 0 && currentTime > this.getLineEndTime(this.maxLine)) {
      this.pause()
      return
    }
    this.timeoutId = setTimeout(() => {
      this.tick()
    }, 50)
  }

  private initTag() {
    this.tags = {}
    for (const tag in tagRegMap) {
      const matches = this.lyric.match(new RegExp(`\\[${tagRegMap[tag as keyof typeof tagRegMap]}:([^\\]]*)]`, 'i'))
      this.tags[tag] = (matches && matches[1]) || ''
    }
    if (this.tags.offset) {
      const parsedOffset = parseInt(this.tags.offset as string)
      this.tags.offset = Number.isNaN(parsedOffset) ? 0 : parsedOffset
    } else this.tags.offset = 0
  }

  private initLines() {
    this.lines = []
    const lines = this.lyric.split(/\r\n|\n|\r/)
    const linesMap: Record<string, LxLyricLine> = {}
    for (const rawLine of lines) {
      const line = rawLine.trim()
      const result = timeFieldExp.exec(line)
      if (!result) continue

      const timeField = result[0]
      const text = line.replace(timeFieldExp, '').trim()
      if (!text) continue

      const times = timeField.match(timeExp)
      if (times == null) continue
      for (let time of times) {
        time = formatTimeLabel(time)
        if (linesMap[time]) {
          linesMap[time].extendedLyrics.push(text)
          continue
        }
        const timeArr = time.split(':')
        if (timeArr.length > 3) continue
        if (timeArr.length < 3) {
          for (let i = 3 - timeArr.length; i--;) timeArr.unshift('0')
        }
        if (timeArr[2].includes('.')) timeArr.splice(2, 1, ...timeArr[2].split('.'))

        const { words, text: displayText } = parseLineWords(text)
        linesMap[time] = {
          time: parseInt(timeArr[0]) * 60 * 60 * 1000 + parseInt(timeArr[1]) * 60 * 1000 + parseInt(timeArr[2]) * 1000 + parseInt(timeArr[3] || '0'),
          text: displayText,
          rawText: text,
          extendedLyrics: [],
          words,
        }
      }
    }

    for (const lrc of this.extendedLyrics) parseExtendedLyric(linesMap, lrc)
    this.lines = Object.values(linesMap).sort((a, b) => a.time - b.time)
    this.maxLine = this.lines.length - 1
  }

  private currentTime() {
    return (getNow() - this._performanceTime) * this._rate + this._startTime
  }

  private findCurLineNum(curTime: number, startIndex = 0) {
    if (curTime <= 0) return 0
    const length = this.lines.length
    for (let index = startIndex; index < length; index++) {
      if (curTime <= this.lines[index].time) return index === 0 ? 0 : index - 1
    }
    return length - 1
  }

  setPlaybackRate(rate: number) {
    this._rate = rate
    if (!this.lines.length || !this.isPlay) return
    this.play(this.currentTime())
  }

  setLyric(lyric: string, extendedLyrics: string[] = []) {
    if (this.isPlay) this.pause()
    this.lyric = lyric ?? ''
    this.extendedLyrics = extendedLyrics ?? []
    this.initTag()
    this.initLines()
    this.curLineNum = 0
    this.curWordIndex = -1
    this.onSetLyric(this.lines)
  }

  play(curTime = 0) {
    if (!this.lines.length) return
    this.pause()
    this.isPlay = true
    this._performanceTime = getNow() - Math.trunc((this.tags.offset as number) + this.offset)
    this._startTime = curTime
    this.curLineNum = -1
    this.curWordIndex = -1
    this.tick()
  }

  pause() {
    if (!this.isPlay) return
    this.isPlay = false
    this.clearTimer()
    this.emitState(this.currentTime())
  }
}
