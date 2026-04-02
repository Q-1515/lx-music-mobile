import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import BackgroundTimer from 'react-native-background-timer'
import { exitApp } from '@/core/common'
import { pause } from '@/core/player/player'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import {
  isSmartSleepCloseSupported,
  onSmartSleepCloseEvent,
  startSmartSleepCloseMonitoring,
  stopSmartSleepCloseMonitoring,
  type SmartSleepCloseState,
} from '@/utils/nativeModules/smartSleepClose'
import { toast } from '@/utils/tools'

type TimeoutMode = 'off' | 'timer' | 'smart'

export interface TimeoutExitInfo {
  time: number
  isPlayedStop: boolean
  mode: TimeoutMode
  smartState: SmartSleepCloseState
  active: boolean
}

type Hook = (info: TimeoutExitInfo) => void

interface TimeoutToolsSnapshot {
  getTime: () => number
  mode: TimeoutMode
  smartState: SmartSleepCloseState
}

const SMART_SLEEP_CLOSE_OPTIONS = {
  inactivityThresholdSeconds: 10 * 60,
  motionWindowSeconds: 5 * 60,
  prewarmSeconds: 5 * 60,
  checkIntervalSeconds: 5,
  sampleIntervalSeconds: 1,
} as const

const createInfo = (tools: TimeoutToolsSnapshot): TimeoutExitInfo => ({
  time: tools.getTime(),
  isPlayedStop: global.lx.isPlayedStop,
  mode: tools.mode,
  smartState: tools.smartState,
  active: tools.mode == 'smart' || tools.getTime() >= 0,
})

const timeoutTools = {
  bgTimeout: null as number | null,
  timeout: null as NodeJS.Timer | null,
  startTime: 0,
  time: -1,
  mode: 'off' as TimeoutMode,
  smartState: 'idle' as SmartSleepCloseState,
  timeHooks: [] as Hook[],
  smartEventSubscribed: false,
  lifecycleBound: false,
  exit() {
    if (settingState.setting['player.timeoutExitPlayed'] && playerState.isPlay) {
      global.lx.isPlayedStop = true
      this.callHooks()
    } else {
      exitApp('Timeout Exit')
    }
  },
  getTime() {
    return Math.max(this.time - Math.round((performance.now() - this.startTime) / 1000), -1)
  },
  callHooks() {
    const info = createInfo(this)
    for (const hook of this.timeHooks) {
      hook(info)
    }
  },
  clearTimer(resetMode = true) {
    if (this.bgTimeout) {
      BackgroundTimer.clearTimeout(this.bgTimeout)
      this.bgTimeout = null
    }
    if (this.timeout) {
      clearInterval(this.timeout)
      this.timeout = null
    }
    this.time = -1
    if (resetMode && this.mode == 'timer') this.mode = 'off'
    this.callHooks()
  },
  start(time: number) {
    this.stopSmart(false)
    this.clearTimer(false)
    this.mode = 'timer'
    this.time = time
    this.startTime = performance.now()
    this.bgTimeout = BackgroundTimer.setTimeout(() => {
      this.clearTimer()
      this.exit()
    }, time * 1000)
    this.timeout = setInterval(() => {
      this.callHooks()
    }, 1000)
    this.callHooks()
  },
  async startSmartNative() {
    if (Platform.OS != 'ios' || !isSmartSleepCloseSupported()) return
    await startSmartSleepCloseMonitoring(SMART_SLEEP_CLOSE_OPTIONS)
  },
  async stopSmartNative() {
    if (Platform.OS != 'ios' || !isSmartSleepCloseSupported()) return
    await stopSmartSleepCloseMonitoring().catch(() => {})
  },
  startSmart() {
    global.lx.isPlayedStop = false
    this.clearTimer()
    this.mode = 'smart'
    this.smartState = 'waiting_inactive'
    this.bindSmartEvents()
    this.bindLifecycleEvents()
    void this.startSmartNative()
    this.callHooks()
  },
  stopSmart(resetMode = true) {
    void this.stopSmartNative()
    if (resetMode) this.mode = 'off'
    this.smartState = 'idle'
    this.callHooks()
  },
  markInteraction() {
    // Smart close now follows a fixed sensor schedule and ignores user interaction resets.
  },
  handlePlay() {
    // Player lifecycle changes no longer restart smart close timing.
  },
  handlePauseLike() {
    // Sensor monitoring remains timer-driven instead of playback-driven.
  },
  bindSmartEvents() {
    if (this.smartEventSubscribed || Platform.OS != 'ios' || !isSmartSleepCloseSupported()) return
    onSmartSleepCloseEvent((event) => {
      if (this.mode != 'smart') return
      switch (event.type) {
        case 'state':
          this.smartState = event.state
          this.callHooks()
          break
        case 'triggered':
          this.mode = 'off'
          this.smartState = 'triggered'
          this.callHooks()
          toast(global.i18n.t('timeout_exit_tip_smart_triggered'))
          void pause().catch(() => {})
          this.smartState = 'idle'
          this.callHooks()
          break
        case 'error':
          this.stopSmart()
          break
      }
    })
    this.smartEventSubscribed = true
  },
  bindLifecycleEvents() {
    if (this.lifecycleBound) return
    global.app_event.on('play', () => { this.handlePlay() })
    global.app_event.on('pause', () => { this.handlePauseLike() })
    global.app_event.on('stop', () => { this.handlePauseLike() })
    global.app_event.on('error', () => { this.handlePauseLike() })
    this.lifecycleBound = true
  },
  addTimeHook(hook: Hook) {
    this.timeHooks.push(hook)
    hook(createInfo(this))
  },
  removeTimeHook(hook: Hook) {
    const index = this.timeHooks.indexOf(hook)
    if (index > -1) this.timeHooks.splice(index, 1)
  },
}

export const startTimeoutExit = (time: number) => {
  timeoutTools.start(time)
}
export const stopTimeoutExit = () => {
  timeoutTools.clearTimer()
}
export const startSmartTimeoutExit = () => {
  timeoutTools.startSmart()
}
export const stopSmartTimeoutExit = () => {
  timeoutTools.stopSmart()
}

export const getTimeoutExitTime = () => {
  return timeoutTools.time
}

export const useTimeoutExitTimeInfo = () => {
  const [info, setInfo] = useState<TimeoutExitInfo>(createInfo(timeoutTools))
  useEffect(() => {
    const hook: Hook = (info) => {
      setInfo(info)
    }
    timeoutTools.addTimeHook(hook)
    return () => { timeoutTools.removeTimeHook(hook) }
  }, [setInfo])

  return info
}

export const onTimeUpdate = (handler: Hook) => {
  timeoutTools.addTimeHook(handler)

  return () => {
    timeoutTools.removeTimeHook(handler)
  }
}

export const cancelTimeoutExit = () => {
  global.lx.isPlayedStop = false
  timeoutTools.callHooks()
}

export const markTimeoutExitInteraction = () => {
  timeoutTools.markInteraction()
}
