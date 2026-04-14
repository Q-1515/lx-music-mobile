import { onRemoteCommand } from '@/utils/nativeModules/utils'
import { pause, play, playNext, playPrev, togglePlay } from '@/core/player/player'
import { markTimeoutExitInteraction } from '@/core/player/timeoutExit'

export default () => {
  onRemoteCommand((event) => {
    markTimeoutExitInteraction()

    switch (event.command) {
      case 'play':
        play()
        break
      case 'pause':
        void pause()
        break
      case 'toggle':
        togglePlay()
        break
      case 'next':
        void playNext()
        break
      case 'previous':
        void playPrev()
        break
      case 'seek':
        if (typeof event.position == 'number') {
          global.app_event.setProgress(event.position)
        }
        break
    }
  })
}
