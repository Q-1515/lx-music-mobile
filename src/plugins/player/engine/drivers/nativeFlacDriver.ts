import { onNativeFlacPlayerEvent } from '../../nativeFlac'
import type { UnifiedPlayerEventBus } from '../EventBus'

export const createNativeFlacDriver = (bus: UnifiedPlayerEventBus) => {
  let isInitialized = false

  const init = () => {
    if (isInitialized) return

    onNativeFlacPlayerEvent((event) => {
      switch (event.type) {
        case 'state':
          bus.emit({
            type: 'state',
            driver: 'nativeFlac',
            state: event.state == 'loading'
              ? 'loading'
              : event.state == 'buffering'
                ? 'buffering'
                : event.state == 'playing'
                  ? 'playing'
                  : event.state == 'paused'
                    ? 'paused'
                    : event.state == 'stopped'
                      ? 'stopped'
                      : 'idle',
          })
          break
        case 'ended':
          bus.emit({
            type: 'ended',
            driver: 'nativeFlac',
            position: event.position,
            duration: event.duration,
            success: event.success,
          })
          break
        case 'error':
          bus.emit({
            type: 'error',
            driver: 'nativeFlac',
            error: event,
          })
          break
      }
    })

    isInitialized = true
  }

  return { init }
}
