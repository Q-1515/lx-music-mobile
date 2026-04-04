import { useEffect, useState } from 'react'
import BackgroundTimer from 'react-native-background-timer'
import { exitApp } from '@/core/common'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'

type TimeoutMode = 'off' | 'timer'

export interface TimeoutExitInfo {
  time: number
  isPlayedStop: boolean
  mode: TimeoutMode
  active: boolean
}

type Hook = (info: TimeoutExitInfo) => void

interface TimeoutToolsSnapshot {
  getTime: () => number
  mode: TimeoutMode
}

const createInfo = (tools: TimeoutToolsSnapshot): TimeoutExitInfo => ({
  time: tools.getTime(),
  isPlayedStop: global.lx.isPlayedStop,
  mode: tools.mode,
  active: tools.getTime() >= 0,
})

const timeoutTools = {
  bgTimeout: null as number | null,
  timeout: null as NodeJS.Timer | null,
  startTime: 0,
  time: -1,
  mode: 'off' as TimeoutMode,
  timeHooks: [] as Hook[],
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

export const markTimeoutExitInteraction = () => {}
