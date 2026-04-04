import { NativeEventEmitter, NativeModules, Platform } from 'react-native'

type StreamingFlacState = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'stopped'

export interface StreamingFlacStateEvent {
  type: 'state'
  state: StreamingFlacState
  position?: number
  duration?: number
}

export interface StreamingFlacErrorEvent {
  type: 'error'
  message?: string
  state?: StreamingFlacState
  position?: number
  duration?: number
}

export interface StreamingFlacEndedEvent {
  type: 'ended'
  state?: StreamingFlacState
  position?: number
  duration?: number
}

export type StreamingFlacEvent =
  | StreamingFlacStateEvent
  | StreamingFlacErrorEvent
  | StreamingFlacEndedEvent

interface NativeStreamingFlacModule {
  openStream?: (url: string, headers?: Record<string, string>, volume?: number, rate?: number, autoplay?: boolean) => Promise<void>
  resume?: () => Promise<void>
  pause?: () => Promise<void>
  stop?: () => Promise<void>
  reset?: () => Promise<void>
  seekTo?: (position: number) => Promise<number>
  setVolume?: (volume: number) => Promise<void>
  setRate?: (rate: number) => Promise<void>
  getPosition?: () => Promise<number>
  getDuration?: () => Promise<number>
  getState?: () => Promise<StreamingFlacState>
  addListener?: (eventName: string) => void
  removeListeners?: (count: number) => void
}

const StreamingFlacPlayerModule = NativeModules.StreamingFlacPlayerModule as NativeStreamingFlacModule | undefined
const emitter = Platform.OS == 'ios' && typeof StreamingFlacPlayerModule?.addListener == 'function' && typeof StreamingFlacPlayerModule?.removeListeners == 'function'
  ? new NativeEventEmitter(StreamingFlacPlayerModule)
  : null

const assertSupported = <K extends keyof NativeStreamingFlacModule>(method: K) => {
  const target = StreamingFlacPlayerModule?.[method]
  if (Platform.OS != 'ios' || typeof target != 'function') {
    throw new Error(`StreamingFlacPlayerModule.${String(method)} is not supported`)
  }
  return target.bind(StreamingFlacPlayerModule) as Exclude<NativeStreamingFlacModule[K], undefined>
}

export const isStreamingFlacSupported = Platform.OS == 'ios' && !!StreamingFlacPlayerModule

export const openStreamingFlac = async(url: string, headers: Record<string, string> = {}, volume = 1, rate = 1, autoplay = true) => {
  const open = assertSupported('openStream')
  return open(url, headers, volume, rate, autoplay)
}

export const resumeStreamingFlac = async() => assertSupported('resume')()
export const pauseStreamingFlac = async() => assertSupported('pause')()
export const stopStreamingFlac = async() => assertSupported('stop')()
export const resetStreamingFlac = async() => assertSupported('reset')()
export const seekStreamingFlac = async(position: number) => assertSupported('seekTo')(position)
export const setStreamingFlacVolume = async(volume: number) => assertSupported('setVolume')(volume)
export const setStreamingFlacRate = async(rate: number) => assertSupported('setRate')(rate)
export const getStreamingFlacPosition = async() => assertSupported('getPosition')()
export const getStreamingFlacDuration = async() => assertSupported('getDuration')()
export const getStreamingFlacState = async() => assertSupported('getState')()

export const onStreamingFlacEvent = (listener: (event: StreamingFlacEvent) => void) => {
  if (!emitter) return () => {}
  const subscription = emitter.addListener('streaming-flac-event', listener)
  return () => {
    subscription.remove()
  }
}
