import { Platform } from 'react-native'
import { parsePlayTime } from '@/utils/common'

const durationDriftTolerance = 1.5

const isOnlineMusic = (musicInfo: LX.Player.PlayMusic | null | undefined) => {
  if (!musicInfo) return false
  return 'progress' in musicInfo ? musicInfo.metadata.musicInfo.source != 'local' : musicInfo.source != 'local'
}

const getMusicInterval = (musicInfo: LX.Player.PlayMusic | null | undefined) => {
  if (!musicInfo) return null
  return 'progress' in musicInfo ? musicInfo.metadata.musicInfo.interval : musicInfo.interval
}

export const getMusicIntervalDuration = (musicInfo: LX.Player.PlayMusic | null | undefined) => {
  return parsePlayTime(getMusicInterval(musicInfo))
}

export const getTimelineDuration = (musicInfo: LX.Player.PlayMusic | null | undefined, playerDuration: number) => {
  const intervalDuration = getMusicIntervalDuration(musicInfo)
  if (!intervalDuration) return playerDuration

  // iOS online/high-quality streams may expose an unstable duration after load/seek.
  if (Platform.OS == 'ios' && isOnlineMusic(musicInfo)) return intervalDuration

  if (!playerDuration) return intervalDuration
  return Math.abs(playerDuration - intervalDuration) > durationDriftTolerance ? intervalDuration : playerDuration
}
