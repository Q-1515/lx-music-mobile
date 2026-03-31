import TrackPlayer from 'react-native-track-player'
import { NativeModules, Platform } from 'react-native'

const NativeTrackPlayerModule = NativeModules.TrackPlayerModule as {
  getPosition?: () => Promise<number>
}

const wait = async(ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const getAccuratePosition = async() => {
  if (Platform.OS == 'ios' && typeof NativeTrackPlayerModule?.getPosition == 'function') {
    return NativeTrackPlayerModule.getPosition()
  }
  return TrackPlayer.getPosition()
}

export const seekToTime = async(targetTime: number) => {
  await TrackPlayer.seekTo(targetTime)
  if (Platform.OS != 'ios') return targetTime

  let position = targetTime
  for (const [delay, tolerance] of [
    [140, 1.2],
    [260, 0.8],
    [420, 0.45],
  ] as const) {
    await wait(delay)
    const currentPosition = await getAccuratePosition().catch(() => position)
    if (currentPosition > 0) position = currentPosition
    if (Math.abs(position - targetTime) <= tolerance) break
    await TrackPlayer.seekTo(targetTime)
  }
  return position
}
