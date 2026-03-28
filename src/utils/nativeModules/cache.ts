import { NativeModules } from 'react-native'

const { CacheModule } = NativeModules

export const getAppCacheSize = async(): Promise<number> => {
  if (!CacheModule) return 0
  return CacheModule.getAppCacheSize().then((size: number) => Math.trunc(size))
}
export const clearAppCache = async(): Promise<void> => {
  if (!CacheModule) return
  return CacheModule.clearAppCache()
}
