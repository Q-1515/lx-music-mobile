import { memo, useMemo } from 'react'

import Text from '@/components/common/Text'

const parseRgb = (color: string) => {
  const match = /rgba?\(([^)]+)\)/.exec(color)
  if (!match) return null
  const parts = match[1].split(',').map(item => item.trim())
  if (parts.length < 3) return null
  return {
    r: parseFloat(parts[0]),
    g: parseFloat(parts[1]),
    b: parseFloat(parts[2]),
    a: parts[3] == null ? 1 : parseFloat(parts[3]),
  }
}

const blendColor = (from: string, to: string, progress: number) => {
  const start = parseRgb(from)
  const end = parseRgb(to)
  if (!start || !end) return progress >= 0.5 ? to : from
  const p = Math.max(0, Math.min(progress, 1))
  const mix = (a: number, b: number) => Math.round(a + (b - a) * p)
  const alpha = start.a + (end.a - start.a) * p
  return `rgba(${mix(start.r, end.r)}, ${mix(start.g, end.g)}, ${mix(start.b, end.b)}, ${alpha.toFixed(2)})`
}

const splitWordProgress = (text: string, progress: number) => {
  const chars = Array.from(text)
  if (!chars.length) return { playedCount: 0, currentProgress: 0 }
  const exact = chars.length * Math.max(0, Math.min(progress, 1))
  const playedCount = Math.floor(exact)
  return {
    playedCount,
    currentProgress: exact - playedCount,
  }
}

export default memo(({
  words,
  activeWordIndex,
  activeWordProgress,
  size,
  playedColor,
  inactiveColor,
}: {
  words: { text: string }[]
  activeWordIndex: number
  activeWordProgress: number
  size: number
  playedColor: string
  inactiveColor: string
}) => {
const content = useMemo(() => {
    return words.map((word, index) => {
      if (index < activeWordIndex) {
        return <Text key={index} size={size} color={playedColor}>{word.text}</Text>
      }
      if (index > activeWordIndex) {
        return <Text key={index} size={size} color={inactiveColor}>{word.text}</Text>
      }

      const { playedCount, currentProgress } = splitWordProgress(word.text, activeWordProgress)
      const chars = Array.from(word.text)
      return (
        <Text key={index} size={size}>
          {
            chars.map((char, charIndex) => {
              if (charIndex < playedCount) return <Text key={charIndex} size={size} color={playedColor}>{char}</Text>
              if (charIndex > playedCount) return <Text key={charIndex} size={size} color={inactiveColor}>{char}</Text>
              return <Text key={charIndex} size={size} color={blendColor(inactiveColor, playedColor, currentProgress)}>{char}</Text>
            })
          }
        </Text>
      )
    })
  }, [words, activeWordIndex, activeWordProgress, size, playedColor, inactiveColor])

  return <>{content}</>
})
