import { AppState, Dimensions, NativeEventEmitter, NativeModules, Platform, Share } from 'react-native'

const { SettingsManager, UtilsModule } = NativeModules

const unsupportedError = (feature: string) => new Error(`${feature} is not supported on ${Platform.OS}`)
const createEmitter = () => UtilsModule && typeof UtilsModule.addListener == 'function' && typeof UtilsModule.removeListeners == 'function'
  ? new NativeEventEmitter(UtilsModule)
  : null

export const exitApp = () => {
  if (typeof UtilsModule?.exitApp == 'function') UtilsModule.exitApp()
}

export const getSupportedAbis = async(): Promise<string[]> => {
  if (typeof UtilsModule?.getSupportedAbis == 'function') return UtilsModule.getSupportedAbis()
  return Platform.OS == 'ios' ? ['arm64'] : []
}

export const installApk = async(filePath: string, fileProviderAuthority: string) => {
  if (typeof UtilsModule?.installApk == 'function') return UtilsModule.installApk(filePath, fileProviderAuthority)
  throw unsupportedError('installApk')
}


export const screenkeepAwake = () => {
  if (global.lx.isScreenKeepAwake) return
  global.lx.isScreenKeepAwake = true
  UtilsModule?.screenkeepAwake?.()
}
export const screenUnkeepAwake = () => {
  // console.log('screenUnkeepAwake')
  if (!global.lx.isScreenKeepAwake) return
  global.lx.isScreenKeepAwake = false
  UtilsModule?.screenUnkeepAwake?.()
}

export const getWIFIIPV4Address = async(): Promise<string> => {
  if (typeof UtilsModule?.getWIFIIPV4Address == 'function') return UtilsModule.getWIFIIPV4Address()
  return ''
}

export const getDeviceName = async(): Promise<string> => {
  if (typeof UtilsModule?.getDeviceName == 'function') {
    return UtilsModule.getDeviceName().then((deviceName: string) => deviceName || 'Unknown')
  }
  // @ts-expect-error
  return Platform.constants?.Model || (Platform.OS == 'ios' ? 'iPhone' : 'Unknown')
}

export const isNotificationsEnabled = async(): Promise<boolean> => {
  if (typeof UtilsModule?.isNotificationsEnabled == 'function') return UtilsModule.isNotificationsEnabled()
  return true
}

export const requestNotificationPermission = async() => new Promise<boolean>((resolve) => {
  if (typeof UtilsModule?.openNotificationPermissionActivity != 'function') {
    resolve(true)
    return
  }
  let subscription = AppState.addEventListener('change', (state) => {
    if (state != 'active') return
    subscription.remove()
    setTimeout(() => {
      void isNotificationsEnabled().then(resolve)
    }, 1000)
  })
  UtilsModule.openNotificationPermissionActivity().then((result: boolean) => {
    if (result) return
    subscription.remove()
    resolve(false)
  })
})

export const shareText = async(shareTitle: string, title: string, text: string): Promise<void> => {
  if (typeof UtilsModule?.shareText == 'function') {
    UtilsModule.shareText(shareTitle, title, text)
    return
  }
  await Share.share({
    title,
    message: text,
  }, {
    subject: shareTitle,
  })
}

export const shareFile = async(shareTitle: string, filePath: string): Promise<void> => {
  const url = filePath.startsWith('file://') ? filePath : `file://${filePath}`
  await Share.share({
    title: shareTitle,
    url,
  }, {
    subject: shareTitle,
  })
}

export const getSystemLocales = async(): Promise<string> => {
  if (typeof UtilsModule?.getSystemLocales == 'function') return UtilsModule.getSystemLocales()

  const locale = SettingsManager?.settings?.AppleLocale
    || SettingsManager?.settings?.AppleLanguages?.[0]
    || Intl.DateTimeFormat().resolvedOptions().locale
    || ''
  return typeof locale == 'string'
    ? locale.replace(/-/g, '_').toLowerCase()
    : ''
}

export const onScreenStateChange = (handler: (state: 'ON' | 'OFF') => void): () => void => {
  const eventEmitter = createEmitter()
  if (!eventEmitter) return () => {}
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const eventListener = eventEmitter.addListener('screen-state', event => {
    handler(event.state as 'ON' | 'OFF')
  })

  return () => {
    eventListener.remove()
  }
}

export const getWindowSize = async(): Promise<{ width: number, height: number }> => {
  if (typeof UtilsModule?.getWindowSize == 'function') return UtilsModule.getWindowSize()

  const window = Dimensions.get('window')
  return {
    width: Math.round(window.width * window.scale),
    height: Math.round(window.height * window.scale),
  }
}

export const onWindowSizeChange = (handler: (size: { width: number, height: number }) => void): () => void => {
  if (typeof UtilsModule?.listenWindowSizeChanged != 'function') {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      handler({
        width: Math.round(window.width * window.scale),
        height: Math.round(window.height * window.scale),
      })
    })
    return () => {
      subscription.remove()
    }
  }

  UtilsModule.listenWindowSizeChanged()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const eventEmitter = new NativeEventEmitter(UtilsModule)
  const eventListener = eventEmitter.addListener('screen-size-changed', event => {
    handler(event as { width: number, height: number })
  })

  return () => {
    eventListener.remove()
  }
}

export const isIgnoringBatteryOptimization = async(): Promise<boolean> => {
  if (typeof UtilsModule?.isIgnoringBatteryOptimization == 'function') return UtilsModule.isIgnoringBatteryOptimization()
  return true
}

export const requestIgnoreBatteryOptimization = async() => new Promise<boolean>((resolve) => {
  if (typeof UtilsModule?.requestIgnoreBatteryOptimization != 'function') {
    resolve(true)
    return
  }
  let subscription = AppState.addEventListener('change', (state) => {
    if (state != 'active') return
    subscription.remove()
    setTimeout(() => {
      void isIgnoringBatteryOptimization().then(resolve)
    }, 1000)
  })
  UtilsModule.requestIgnoreBatteryOptimization().then((result: boolean) => {
    if (result) return
    subscription.remove()
    resolve(false)
  })
})
