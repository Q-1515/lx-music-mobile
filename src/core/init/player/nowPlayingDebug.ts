import { onNowPlayingDebug } from '@/utils/nativeModules/utils'
import { log } from '@/utils/log'

export default () => {
  onNowPlayingDebug((event) => {
    log.info('[NowPlayingNative] event', event)
  })
}
