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
  let stableCount = 0
  for (const [delay, tolerance] of [
    [140, 1.2],
    [200, 0.75],
    [280, 0.4],
    [360, 0.22],
    [520, 0.12],
  ] as const) {
    await wait(delay)
    const currentPosition = await getAccuratePosition().catch(() => position)
    const nextPosition = currentPosition > 0 ? currentPosition : position
    // eslint-disable-next-line require-atomic-updates
    position = nextPosition
    if (Math.abs(position - targetTime) <= tolerance) {
      stableCount++
      if (stableCount > 1 || tolerance <= 0.22) break
      continue
    }
    stableCount = 0
    await TrackPlayer.seekTo(targetTime)
  }
  const finalPosition = await getAccuratePosition().catch(() => position)
  // eslint-disable-next-line require-atomic-updates
  position = finalPosition > 0 ? finalPosition : position
  return position
}
