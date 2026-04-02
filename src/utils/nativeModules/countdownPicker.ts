import { NativeModules, Platform } from 'react-native'

interface NativeCountdownPickerModule {
  open?: (options?: {
    minutes?: number
    maxMinutes?: number
    title?: string
    confirmTitle?: string
    cancelTitle?: string
    hourTitle?: string
    minuteTitle?: string
  }) => Promise<number | null>
}

const CountdownPickerModule = NativeModules.CountdownPickerModule as NativeCountdownPickerModule | undefined

export const isNativeCountdownPickerSupported = () => Platform.OS == 'ios' && typeof CountdownPickerModule?.open == 'function'

export const openNativeCountdownPicker = async(options: {
  minutes?: number
  maxMinutes?: number
  title?: string
  confirmTitle?: string
  cancelTitle?: string
  hourTitle?: string
  minuteTitle?: string
} = {}) => {
  if (!isNativeCountdownPickerSupported()) throw new Error('CountdownPickerModule.open is not supported')
  return CountdownPickerModule!.open!(options)
}
