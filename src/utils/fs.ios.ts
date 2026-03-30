import RNFS from 'react-native-fs'
import pako from 'pako'

export interface FileType {
  name: string
  path: string
  size: number
  isDirectory: boolean
  isFile: boolean
  lastModified: number
  mimeType?: string | null
  canRead: boolean
}

export interface OpenDocumentOptions {
  extTypes?: string[]
  toPath?: string
}

export type Encoding = 'utf8' | 'ascii' | 'base64'
export type HashAlgorithm = 'md5' | 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512'

const unsupportedError = (feature: string) => new Error(`${feature} is not supported on ios`)
export const isSystemFileSelectorSupported = false
export const isManagedFolderSupported = false

const audioMimeTypeMap: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
}

const normalizePath = (path: string) => path.startsWith('file://')
  ? decodeURIComponent(path.replace(/^file:\/\//, ''))
  : decodeURIComponent(path)

const getName = (path: string) => {
  const normalizedPath = normalizePath(path)
  return normalizedPath.split('/').pop() ?? normalizedPath
}

const extnameRaw = (name: string) => name.lastIndexOf('.') > 0 ? name.substring(name.lastIndexOf('.') + 1) : ''
const getMimeType = (path: string) => {
  const ext = extnameRaw(getName(path)).toLowerCase()
  return audioMimeTypeMap[ext] ?? null
}

const toFileType = (path: string, size: number, isDirectory: boolean, lastModified?: Date | string | number | null): FileType => ({
  name: getName(path),
  path: normalizePath(path),
  size,
  isDirectory,
  isFile: !isDirectory,
  lastModified: lastModified ? new Date(lastModified).getTime() : Date.now(),
  mimeType: getMimeType(path),
  canRead: true,
})

const gzipBuffer = (buffer: Buffer | Uint8Array) => Buffer.from(pako.gzip(buffer))
const unGzipBuffer = (buffer: Buffer | Uint8Array) => Buffer.from(pako.ungzip(buffer))

export const extname = extnameRaw

export const temporaryDirectoryPath = RNFS.CachesDirectoryPath
export const externalStorageDirectoryPath = RNFS.DocumentDirectoryPath
export const privateStorageDirectoryPath = RNFS.DocumentDirectoryPath

export const getExternalStoragePaths = async(_is_removable?: boolean) => [RNFS.DocumentDirectoryPath]

export const selectManagedFolder = async(_isPersist: boolean = false): Promise<FileType> => {
  throw unsupportedError('Folder selection')
}
export const selectFile = async(_options: OpenDocumentOptions): Promise<FileType & { data?: string }> => {
  throw unsupportedError('File selection')
}
export const removeManagedFolder = async(_path: string) => {
  throw unsupportedError('Managed folder removal')
}
export const getManagedFolders = async(): Promise<string[]> => []
export const getPersistedUriList = async(): Promise<string[]> => []

export const readDir = async(path: string): Promise<FileType[]> => {
  const list = await RNFS.readDir(normalizePath(path))
  return list.map(item => toFileType(item.path, Number(item.size), item.isDirectory(), item.mtime))
}

export const unlink = async(path: string) => {
  const normalizedPath = normalizePath(path)
  const exists = await RNFS.exists(normalizedPath)
  if (!exists) return
  return RNFS.unlink(normalizedPath)
}

export const mkdir = async(path: string) => RNFS.mkdir(normalizePath(path))

export const stat = async(path: string): Promise<FileType> => {
  const info = await RNFS.stat(normalizePath(path))
  return toFileType(info.path, Number(info.size), info.isDirectory(), info.mtime)
}
export const hash = async(path: string, algorithm: HashAlgorithm) => RNFS.hash(normalizePath(path), algorithm)

export const readFile = async(path: string, encoding: Encoding = 'utf8') => RNFS.readFile(normalizePath(path), encoding)

export const moveFile = async(fromPath: string, toPath: string) => RNFS.moveFile(normalizePath(fromPath), normalizePath(toPath))
export const gzipFile = async(fromPath: string, toPath: string) => {
  const source = await RNFS.readFile(normalizePath(fromPath), 'base64')
  const compressed = gzipBuffer(Buffer.from(source, 'base64')).toString('base64')
  return RNFS.writeFile(normalizePath(toPath), compressed, 'base64')
}
export const unGzipFile = async(fromPath: string, toPath: string) => {
  const source = await RNFS.readFile(normalizePath(fromPath), 'base64')
  const uncompressed = unGzipBuffer(Buffer.from(source, 'base64')).toString('base64')
  return RNFS.writeFile(normalizePath(toPath), uncompressed, 'base64')
}
export const gzipString = async(data: string, _encoding: Encoding = 'utf8') => gzipBuffer(Buffer.from(data, 'utf8')).toString('base64')
export const unGzipString = async(data: string, _encoding: Encoding = 'utf8') => unGzipBuffer(Buffer.from(data, 'base64')).toString('utf8')

export const existsFile = async(path: string) => RNFS.exists(normalizePath(path))

export const rename = async(path: string, name: string) => {
  const normalizedPath = normalizePath(path)
  const parent = normalizedPath.slice(0, normalizedPath.lastIndexOf('/'))
  const target = `${parent}/${name}`
  await RNFS.moveFile(normalizedPath, target)
  return target
}

export const writeFile = async(path: string, data: string, encoding: Encoding = 'utf8') => RNFS.writeFile(normalizePath(path), data, encoding)

export const appendFile = async(path: string, data: string, encoding: Encoding = 'utf8') => RNFS.appendFile(normalizePath(path), data, encoding)

export const downloadFile = (url: string, path: string, options: Omit<RNFS.DownloadFileOptions, 'fromUrl' | 'toFile'> = {}) => {
  if (!options.headers) {
    options.headers = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile',
    }
  }
  return RNFS.downloadFile({
    fromUrl: url,
    toFile: normalizePath(path),
    ...options,
  })
}

export const stopDownload = (jobId: number) => {
  RNFS.stopDownload(jobId)
}
