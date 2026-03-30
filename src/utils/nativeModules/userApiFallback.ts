import { aesEncryptSync, AES_MODE, rsaEncryptSync, RSA_PADDING } from '@/utils/nativeModules/crypto'
import { stringMd5 } from 'react-native-quick-md5'

type ApiAction = 'init' | 'request' | 'cancelRequest' | 'response' | 'showUpdateAlert' | 'log'

export interface FallbackScriptEvent {
  action: ApiAction
  data?: any
  type?: 'log' | 'info' | 'warn' | 'error'
  log?: string
}

export interface ScriptInfo {
  id: string
  name: string
  description: string
  version: string
  author: string
  homepage: string
  script: string
}

type ScriptRequestHandler = (event: { source: LX.Source, action: string, info: any }) => any
type Listener = (event: FallbackScriptEvent) => void

const listeners = new Set<Listener>()

const KEY_PREFIX = {
  publicKeyStart: '-----BEGIN PUBLIC KEY-----',
  publicKeyEnd: '-----END PUBLIC KEY-----',
}

const EVENT_NAMES = {
  request: 'request',
  inited: 'inited',
  updateAlert: 'updateAlert',
} as const

const allSources = ['kw', 'kg', 'tx', 'wy', 'mg', 'local'] as const
const supportQualitys: Record<string, LX.Quality[]> = {
  kw: ['128k', '320k', 'flac', 'flac24bit'],
  kg: ['128k', '320k', 'flac', 'flac24bit'],
  tx: ['128k', '320k', 'flac', 'flac24bit'],
  wy: ['128k', '320k', 'flac', 'flac24bit'],
  mg: ['128k', '320k', 'flac', 'flac24bit'],
  local: [],
}
const supportActions: Record<string, LX.UserApi.UserApiSourceInfoActions[]> = {
  kw: ['musicUrl'],
  kg: ['musicUrl'],
  tx: ['musicUrl'],
  wy: ['musicUrl'],
  mg: ['musicUrl'],
  xm: ['musicUrl'],
  local: ['musicUrl', 'lyric', 'pic'],
}

const emit = (event: FallbackScriptEvent) => {
  for (const listener of Array.from(listeners)) listener(event)
}

const isTypedArray = (value: any): value is Uint8Array => ArrayBuffer.isView(value)

const toUint8Array = (input: string | number[] | Uint8Array, encoding?: string) => {
  if (typeof input == 'string') {
    switch (encoding) {
      case 'base64':
        return Uint8Array.from(Buffer.from(input, 'base64'))
      case 'hex':
        return Uint8Array.from(Buffer.from(input, 'hex'))
      case 'binary':
        return Uint8Array.from(Buffer.from(input, 'binary'))
      case 'utf-8':
      case 'utf8':
      case undefined:
        return Uint8Array.from(Buffer.from(input, 'utf8'))
      default:
        throw new Error(`Unsupported string encoding: ${encoding}`)
    }
  }
  if (Array.isArray(input)) return Uint8Array.from(input)
  if (isTypedArray(input)) return Uint8Array.from(input)
  throw new Error('Unsupported input type')
}

const bufferToString = (input: number[] | Uint8Array, format = 'utf8') => {
  const buffer = Buffer.from(Array.isArray(input) ? input : Array.from(input))
  switch (format) {
    case 'binary':
      return buffer.toString('binary')
    case 'hex':
      return buffer.toString('hex')
    case 'base64':
      return buffer.toString('base64')
    case 'utf-8':
    case 'utf8':
    default:
      return buffer.toString('utf8')
  }
}

const dataToB64 = (data: string | number[] | Uint8Array) => {
  if (typeof data == 'string') return Buffer.from(data, 'utf8').toString('base64')
  if (Array.isArray(data)) return Buffer.from(data).toString('base64')
  if (isTypedArray(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
  throw new Error('data type error')
}

const verifyLyricInfo = (info: any) => {
  if (typeof info != 'object' || typeof info.lyric != 'string') throw new Error('failed')
  if (info.lyric.length > 51200) throw new Error('failed')
  return {
    lyric: info.lyric,
    tlyric: (typeof info.tlyric == 'string' && info.tlyric.length < 5120) ? info.tlyric : null,
    rlyric: (typeof info.rlyric == 'string' && info.rlyric.length < 5120) ? info.rlyric : null,
    lxlyric: (typeof info.lxlyric == 'string' && info.lxlyric.length < 8192) ? info.lxlyric : null,
  }
}

class UserApiFallbackRuntime {
  private readonly info: ScriptInfo
  private requestHandler: ScriptRequestHandler | null = null
  private readonly pendingNativeRequests = new Map<string, { callback: (err: Error | null, resp: any, body: any) => void }>()
  private readonly timeoutHandles = new Map<number, ReturnType<typeof setTimeout>>()
  private timeoutId = 1
  private isInited = false
  private isShowedUpdateAlert = false
  private destroyed = false

  constructor(info: ScriptInfo) {
    this.info = info
  }

  private emitInit(status: boolean, info: any, errorMessage?: string) {
    emit({
      action: 'init',
      data: {
        info,
        status,
        errorMessage,
      },
    })
  }

  private emitLog(type: NonNullable<FallbackScriptEvent['type']>, logText: string) {
    emit({
      action: 'log',
      type,
      log: logText,
    })
  }

  private createConsole() {
    const send = (type: NonNullable<FallbackScriptEvent['type']>, args: any[]) => {
      const text = args.map(arg => typeof arg == 'string' ? arg : arg instanceof Error ? arg.stack ?? arg.message : JSON.stringify(arg)).join(' ')
      this.emitLog(type, text)
    }
    return {
      log: (...args: any[]) => send('log', args),
      info: (...args: any[]) => send('info', args),
      warn: (...args: any[]) => send('warn', args),
      error: (...args: any[]) => send('error', args),
    }
  }

  private setTimer = (callback: (...args: any[]) => void, timeout = 0, ...args: any[]) => {
    const id = this.timeoutId++
    const handle = setTimeout(() => {
      this.timeoutHandles.delete(id)
      callback(...args)
    }, Math.max(0, timeout))
    this.timeoutHandles.set(id, handle)
    return id
  }

  private clearTimer = (id: number) => {
    const handle = this.timeoutHandles.get(id)
    if (!handle) return
    clearTimeout(handle)
    this.timeoutHandles.delete(id)
  }

  private buildSourceInfo(data: any) {
    if (!data) throw new Error('Missing required parameter init info')
    const sourceInfo: { sources: Partial<LX.UserApi.UserApiSources> } = { sources: {} }
    for (const source of allSources) {
      const userSource = data.sources?.[source]
      if (!userSource || userSource.type !== 'music') continue
      sourceInfo.sources[source] = {
        type: 'music',
        name: userSource.name ?? source,
        actions: supportActions[source].filter(action => userSource.actions?.includes(action)),
        qualitys: supportQualitys[source].filter(quality => userSource.qualitys?.includes(quality)),
      }
    }
    return sourceInfo
  }

  private buildUtils() {
    return {
      crypto: {
        aesEncrypt: (buffer: string | number[] | Uint8Array, mode: string, key: string | number[] | Uint8Array, iv: string | number[] | Uint8Array) => {
          switch (mode) {
            case 'aes-128-cbc':
              return toUint8Array(aesEncryptSync(dataToB64(buffer), dataToB64(key), dataToB64(iv), AES_MODE.CBC_128_PKCS7Padding), 'base64')
            case 'aes-128-ecb':
              return toUint8Array(aesEncryptSync(dataToB64(buffer), dataToB64(key), '', AES_MODE.ECB_128_NoPadding), 'base64')
            default:
              throw new Error('Unsupported aes mode')
          }
        },
        rsaEncrypt: (buffer: string | number[] | Uint8Array, key: string) => {
          if (typeof key != 'string') throw new Error('Invalid RSA key')
          const normalizedKey = key
            .replace(KEY_PREFIX.publicKeyStart, '')
            .replace(KEY_PREFIX.publicKeyEnd, '')
          return toUint8Array(rsaEncryptSync(dataToB64(buffer), normalizedKey, RSA_PADDING.NoPadding), 'base64')
        },
        randomBytes: (size: number) => {
          const bytes = new Uint8Array(size)
          for (let i = 0; i < size; i++) bytes[i] = Math.floor(Math.random() * 256)
          return bytes
        },
        md5: (str: string) => {
          if (typeof str != 'string') throw new Error('param required a string')
          return stringMd5(encodeURIComponent(str))
        },
      },
      buffer: {
        from: (input: string | number[] | Uint8Array, encoding?: string) => toUint8Array(input, encoding),
        bufToString: (buf: number[] | Uint8Array, format?: string) => bufferToString(buf, format),
      },
    }
  }

  private normalizeRequestSuccess(data: any) {
    switch (data.action) {
      case 'musicUrl':
        if (typeof data.response != 'string' || data.response.length > 2048 || !/^https?:/.test(data.response)) throw new Error('failed')
        return {
          source: data.source,
          action: data.action,
          data: {
            type: data.info.type,
            url: data.response,
          },
        }
      case 'lyric':
        return {
          source: data.source,
          action: data.action,
          data: verifyLyricInfo(data.response),
        }
      case 'pic':
        if (typeof data.response != 'string' || data.response.length > 2048 || !/^https?:/.test(data.response)) throw new Error('failed')
        return {
          source: data.source,
          action: data.action,
          data: data.response,
        }
      default:
        throw new Error('Unknown request action')
    }
  }

  private handleScriptRequest = async(eventData: { requestKey: string, data: any }) => {
    if (!this.requestHandler) {
      emit({
        action: 'response',
        data: {
          requestKey: eventData.requestKey,
          status: false,
          errorMessage: 'Request event is not defined',
        },
      })
      return
    }
    try {
      const response = await Promise.resolve(this.requestHandler({
        source: eventData.data.source,
        action: eventData.data.action,
        info: eventData.data.info,
      }))
      emit({
        action: 'response',
        data: {
          requestKey: eventData.requestKey,
          status: true,
          result: this.normalizeRequestSuccess({
            ...eventData.data,
            response,
          }),
        },
      })
    } catch (error: any) {
      emit({
        action: 'response',
        data: {
          requestKey: eventData.requestKey,
          status: false,
          errorMessage: error?.message ?? 'failed',
        },
      })
    }
  }

  private handleNativeResponse(data: any) {
    const target = this.pendingNativeRequests.get(data.requestKey)
    if (!target) return
    this.pendingNativeRequests.delete(data.requestKey)
    if (data.error == null) {
      target.callback(null, {
        statusCode: data.response?.statusCode,
        statusMessage: data.response?.statusMessage,
        headers: data.response?.headers,
        body: data.response?.body,
      }, data.response?.body)
    } else {
      target.callback(new Error(data.error), null, null)
    }
  }

  sendAction(action: 'request' | 'response', data: any) {
    if (this.destroyed) return false
    switch (action) {
      case 'request':
        void this.handleScriptRequest(data)
        return true
      case 'response':
        this.handleNativeResponse(data)
        return true
      default:
        return false
    }
  }

  execute() {
    const consoleApi = this.createConsole()
    const blockedEval = () => {
      throw new Error('eval is not available')
    }
    const blockedFunction = new Proxy(Function.prototype.constructor, {
      apply() {
        throw new Error('Dynamic code execution is not allowed.')
      },
      construct() {
        throw new Error('Dynamic code execution is not allowed.')
      },
    })

    const lx = {
      EVENT_NAMES,
      request: (url: string, { method = 'get', timeout, headers, body, form, formData, binary }: any, callback: (err: Error | null, resp: any, body: any) => void) => {
        const requestKey = `script_request_${Math.random().toString().slice(2)}`
        this.pendingNativeRequests.set(requestKey, { callback })
        emit({
          action: 'request',
          data: {
            requestKey,
            url,
            options: {
              method,
              timeout,
              headers,
              body,
              form,
              formData,
              binary: binary === true,
            },
          },
        })
        return () => {
          if (!this.pendingNativeRequests.delete(requestKey)) return
          emit({
            action: 'cancelRequest',
            data: requestKey,
          })
        }
      },
      send: (eventName: string, data: any) => {
        return new Promise<void>((resolve, reject) => {
          switch (eventName) {
            case EVENT_NAMES.inited:
              if (this.isInited) return reject(new Error('Script is inited'))
              this.isInited = true
              try {
                this.emitInit(true, this.buildSourceInfo(data))
                resolve()
              } catch (error: any) {
                this.emitInit(false, null, error?.message ?? 'Init failed')
                reject(error)
              }
              break
            case EVENT_NAMES.updateAlert:
              if (this.isShowedUpdateAlert) return reject(new Error('The update alert can only be called once.'))
              this.isShowedUpdateAlert = true
              emit({
                action: 'showUpdateAlert',
                data: {
                  name: this.info.name,
                  log: String(data?.log ?? ''),
                  updateUrl: typeof data?.updateUrl == 'string' ? data.updateUrl : '',
                },
              })
              resolve()
              break
            default:
              reject(new Error(`The event is not supported: ${eventName}`))
          }
        })
      },
      on: (eventName: string, handler: ScriptRequestHandler) => {
        if (eventName != EVENT_NAMES.request) return Promise.reject(new Error(`The event is not supported: ${eventName}`))
        this.requestHandler = handler
        return Promise.resolve()
      },
      utils: this.buildUtils(),
      currentScriptInfo: {
        name: this.info.name,
        description: this.info.description,
        version: this.info.version,
        author: this.info.author,
        homepage: this.info.homepage,
        rawScript: this.info.script,
      },
      version: '2.0.0',
      env: 'mobile',
    }

    const sandboxGlobal: Record<string, any> = {
      lx,
      globalThis: null,
      window: null,
      self: null,
      global: null,
    }
    sandboxGlobal.globalThis = sandboxGlobal
    sandboxGlobal.window = sandboxGlobal
    sandboxGlobal.self = sandboxGlobal
    sandboxGlobal.global = sandboxGlobal
    sandboxGlobal.lx = lx
    sandboxGlobal.setTimeout = this.setTimer
    sandboxGlobal.clearTimeout = this.clearTimer
    sandboxGlobal.console = consoleApi
    sandboxGlobal.Buffer = Buffer
    sandboxGlobal.Function = blockedFunction
    sandboxGlobal.eval = blockedEval

    try {
      const runner = new Function(
        'globalThis',
        'window',
        'self',
        'global',
        'lx',
        'console',
        'setTimeout',
        'clearTimeout',
        'Buffer',
        'Function',
        'eval',
        `${this.info.script}\n//# sourceURL=${this.info.id}.user-api.js`,
      )
      runner.call(
        sandboxGlobal,
        sandboxGlobal,
        sandboxGlobal,
        sandboxGlobal,
        sandboxGlobal,
        lx,
        consoleApi,
        this.setTimer,
        this.clearTimer,
        Buffer,
        blockedFunction,
        blockedEval,
      )
    } catch (error: any) {
      this.emitInit(false, null, error?.message ?? 'Load script failed')
    }
  }

  destroy() {
    this.destroyed = true
    this.requestHandler = null
    this.pendingNativeRequests.clear()
    for (const handle of this.timeoutHandles.values()) clearTimeout(handle)
    this.timeoutHandles.clear()
  }
}

let runtime: UserApiFallbackRuntime | null = null

export const hasUserApiFallback = true

export const loadFallbackScript = (info: ScriptInfo) => {
  runtime?.destroy()
  runtime = new UserApiFallbackRuntime(info)
  runtime.execute()
}

export const sendFallbackAction = (action: 'request' | 'response', data: any) => {
  if (!runtime) return false
  return runtime.sendAction(action, data)
}

export const onFallbackScriptAction = (handler: Listener) => {
  listeners.add(handler)
  return () => {
    listeners.delete(handler)
  }
}

export const destroyFallbackUserApi = () => {
  runtime?.destroy()
  runtime = null
}
