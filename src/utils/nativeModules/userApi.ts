import { NativeEventEmitter, NativeModules, Platform } from 'react-native'
import { destroyFallbackUserApi, hasUserApiFallback, loadFallbackScript, onFallbackScriptAction, sendFallbackAction } from './userApiFallback'

const { UserApiModule } = NativeModules
const useFallbackUserApi = !UserApiModule && Platform.OS == 'ios' && hasUserApiFallback
export const isUserApiSupported = !!UserApiModule || useFallbackUserApi

const assertUserApiSupport = () => {
  if (!UserApiModule && !useFallbackUserApi) throw new Error('User API is not supported on this platform yet')
}

let loadScriptInfo: LX.UserApi.UserApiInfo | null = null
export const loadScript = (info: LX.UserApi.UserApiInfo & { script: string }) => {
  loadScriptInfo = info
  assertUserApiSupport()
  const payload = {
    id: info.id,
    name: info.name,
    description: info.description,
    version: info.version ?? '',
    author: info.author ?? '',
    homepage: info.homepage ?? '',
    script: info.script,
  }
  if (UserApiModule) {
    UserApiModule.loadScript(payload)
    return
  }
  loadFallbackScript(payload)
}

export interface SendResponseParams {
  requestKey: string
  error: string | null
  response: {
    statusCode: number
    statusMessage: string
    headers: Record<string, string>
    body: any
  } | null
}
export interface SendActions {
  request: LX.UserApi.UserApiRequestParams
  response: SendResponseParams
}
export const sendAction = <T extends keyof SendActions>(action: T, data: SendActions[T]) => {
  if (UserApiModule) return UserApiModule.sendAction(action, JSON.stringify(data))
  if (useFallbackUserApi) return sendFallbackAction(action, data)
  return false
}

// export const clearAppCache = CacheModule.clearAppCache as () => Promise<void>

export interface InitParams {
  status: boolean
  errorMessage: string
  info: LX.UserApi.UserApiInfo
}

export interface ResponseParams {
  status: boolean
  errorMessage?: string
  requestKey: string
  result: any
}
export interface UpdateInfoParams {
  name: string
  log: string
  updateUrl: string
}
export interface RequestParams {
  requestKey: string
  url: string
  options: {
    method: string
    data: any
    timeout: number
    headers: any
    binary: boolean
  }
}
export type CancelRequestParams = string

export interface Actions {
  init: InitParams
  request: RequestParams
  cancelRequest: CancelRequestParams
  response: ResponseParams
  showUpdateAlert: UpdateInfoParams
  log: string
}
export type ActionsEvent = { [K in keyof Actions]: { action: K, data: Actions[K] } }[keyof Actions]

export const onScriptAction = (handler: (event: ActionsEvent) => void): () => void => {
  if (useFallbackUserApi) {
    return onFallbackScriptAction((event) => {
      if (event.action == 'init') {
        if (event.data?.info) event.data.info = { ...loadScriptInfo, ...event.data.info }
        else event.data = { ...event.data, info: { ...loadScriptInfo } }
      } else if ((event as { action: string }).action == 'showUpdateAlert') {
        if (!loadScriptInfo?.allowShowUpdateAlert) return
      }
      handler(event as ActionsEvent)
    })
  }
  if (!UserApiModule) return () => {}
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const eventEmitter = new NativeEventEmitter(UserApiModule)
  const eventListener = eventEmitter.addListener('api-action', event => {
    if (typeof event.data == 'string') event.data = JSON.parse(event.data as string)
    if (event.action == 'init') {
      if (event.data.info) event.data.info = { ...loadScriptInfo, ...event.data.info }
      else event.data.info = { ...loadScriptInfo }
    } else if (event.action == 'showUpdateAlert') {
      if (!loadScriptInfo?.allowShowUpdateAlert) return
    }
    handler(event as ActionsEvent)
  })

  return () => {
    eventListener.remove()
  }
}

export const destroy = () => {
  if (UserApiModule) {
    UserApiModule.destroy()
    return
  }
  if (useFallbackUserApi) destroyFallbackUserApi()
}
