import type { UnifiedPlayerEvent } from './types'

type Listener = (event: UnifiedPlayerEvent) => void

export class UnifiedPlayerEventBus {
  private readonly listeners = new Set<Listener>()

  emit(event: UnifiedPlayerEvent) {
    for (const listener of this.listeners) listener(event)
  }

  on(listener: Listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

