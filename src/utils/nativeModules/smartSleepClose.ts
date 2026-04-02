import { NativeEventEmitter, NativeModules, Platform } from 'react-native'

export type SmartSleepCloseState = 'idle' | 'waiting_inactive' | 'collecting_motion' | 'triggered'

export interface SmartSleepCloseStateEvent {
  type: 'state'
  state: SmartSleepCloseState
  inactiveSeconds?: number
}

export interface SmartSleepCloseTriggeredEvent {
  type: 'triggered'
  state: 'triggered'
  inactiveSeconds?: number
}

export interface SmartSleepCloseErrorEvent {
  type: 'error'
  message?: string
}

export type SmartSleepCloseEvent =
  | SmartSleepCloseStateEvent
  | SmartSleepCloseTriggeredEvent
  | SmartSleepCloseErrorEvent

interface NativeSmartSleepCloseModule {
  startMonitoring?: (options?: {
    inactivityThresholdSeconds?: number
    motionWindowSeconds?: number
    prewarmSeconds?: number
    checkIntervalSeconds?: number
    sampleIntervalSeconds?: number
  }) => Promise<void>
  stopMonitoring?: () => Promise<void>
  markUserInteraction?: () => Promise<void>
  getState?: () => Promise<{ state: SmartSleepCloseState, active: boolean }>
  addListener?: (eventName: string) => void
  removeListeners?: (count: number) => void
}

const SmartSleepCloseModule = NativeModules.SmartSleepCloseModule as NativeSmartSleepCloseModule | undefined
const emitter = Platform.OS == 'ios' && typeof SmartSleepCloseModule?.addListener == 'function' && typeof SmartSleepCloseModule?.removeListeners == 'function'
  ? new NativeEventEmitter(SmartSleepCloseModule)
  : null

const assertSupported = <K extends keyof NativeSmartSleepCloseModule>(method: K) => {
  const target = SmartSleepCloseModule?.[method]
  if (Platform.OS != 'ios' || typeof target != 'function') {
    throw new Error(`SmartSleepCloseModule.${String(method)} is not supported`)
  }
  return target.bind(SmartSleepCloseModule) as Exclude<NativeSmartSleepCloseModule[K], undefined>
}

export const isSmartSleepCloseSupported = () => Platform.OS == 'ios' && !!SmartSleepCloseModule

export const startSmartSleepCloseMonitoring = async(options: {
  inactivityThresholdSeconds?: number
  motionWindowSeconds?: number
  prewarmSeconds?: number
  checkIntervalSeconds?: number
  sampleIntervalSeconds?: number
} = {}) => assertSupported('startMonitoring')(options)

export const stopSmartSleepCloseMonitoring = async() => assertSupported('stopMonitoring')()
export const markSmartSleepCloseInteraction = async() => assertSupported('markUserInteraction')()
export const getSmartSleepCloseState = async() => assertSupported('getState')()

export const onSmartSleepCloseEvent = (listener: (event: SmartSleepCloseEvent) => void) => {
  if (!emitter) return () => {}
  const subscription = emitter.addListener('smart-sleep-close-event', listener)
  return () => {
    subscription.remove()
  }
}
