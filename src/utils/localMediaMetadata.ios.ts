import { NativeModules } from 'react-native'
import { temporaryDirectoryPath, readDir, unlink, extname, stat } from '@/utils/fs'

export interface MusicMetadata {
  type: 'mp3' | 'flac' | 'ogg' | 'wav' | 'm4a' | 'aac'
  bitrate: string
  interval: number
  size: number
  ext: 'mp3' | 'flac' | 'ogg' | 'wav' | 'm4a' | 'aac'
  albumName: string
  singer: string
  name: string
}

export type MusicMetadataFull = MusicMetadata

let nativeLocalMediaMetadata: null | {
  readMetadata?: (filePath: string) => Promise<MusicMetadataFull | null>
  writeMetadata?: (filePath: string, metadata: Pick<MusicMetadataFull, 'albumName' | 'singer' | 'name'>, isOverwrite?: boolean) => Promise<void>
  writePic?: (filePath: string, picPath: string) => Promise<void>
  readLyric?: (filePath: string, isReadLrcFile?: boolean) => Promise<string>
  writeLyric?: (filePath: string, lyric: string) => Promise<void>
  readPic?: (filePath: string, targetPath: string) => Promise<string>
} = null

if (NativeModules.LocalMediaMetadata) {
  nativeLocalMediaMetadata = NativeModules.LocalMediaMetadata
} else {
  try {
    // Keep the require inside a try block so missing iOS native linkage does not crash the app.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    nativeLocalMediaMetadata = require('react-native-local-media-metadata')
  } catch {
    nativeLocalMediaMetadata = null
  }
}

let cleared = false
const picCachePath = temporaryDirectoryPath + '/local-media-metadata'
const unsupportedError = new Error('Local media metadata is not supported on ios yet')

const getExt = (filePath: string) => {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case 'flac':
    case 'ogg':
    case 'wav':
    case 'm4a':
    case 'aac':
      return ext
    case 'mp3':
    default:
      return 'mp3'
  }
}

const createFallbackMetadata = async(filePath: string): Promise<MusicMetadataFull> => {
  const file = await stat(filePath)
  const index = file.name.lastIndexOf('.')
  const name = index > 0 ? file.name.substring(0, index) : file.name
  const ext = getExt(filePath)
  return {
    type: ext,
    bitrate: '0',
    interval: 0,
    size: file.size,
    ext,
    albumName: '',
    singer: '',
    name,
  }
}

export const scanAudioFiles = async(dirPath: string) => {
  const files = await readDir(dirPath)
  return files.filter(file => {
    if (file.mimeType?.startsWith('audio/')) return true
    if (extname(file?.name ?? '') === 'ogg') return true
    return false
  }).map(file => file)
}

const clearPicCache = async() => {
  await unlink(picCachePath)
  cleared = true
}

export const readMetadata = async(filePath: string): Promise<MusicMetadataFull | null> => {
  if (nativeLocalMediaMetadata?.readMetadata) {
    return nativeLocalMediaMetadata.readMetadata(filePath)
  }
  return createFallbackMetadata(filePath)
}

export const writeMetadata = async(filePath: string, metadata: MusicMetadataFull): Promise<void> => {
  if (nativeLocalMediaMetadata?.writeMetadata) {
    return nativeLocalMediaMetadata.writeMetadata(filePath, {
      name: metadata.name,
      singer: metadata.singer,
      albumName: metadata.albumName,
    }, false)
  }
  throw unsupportedError
}

export const writePic = async(filePath: string, picPath: string): Promise<void> => {
  if (nativeLocalMediaMetadata?.writePic) {
    return nativeLocalMediaMetadata.writePic(filePath, picPath)
  }
  throw unsupportedError
}

export const readLyric = async(filePath: string, raw?: boolean): Promise<string> => {
  if (nativeLocalMediaMetadata?.readLyric) {
    return nativeLocalMediaMetadata.readLyric(filePath, raw ?? true)
  }
  throw unsupportedError
}

export const writeLyric = async(filePath: string, lyric: string): Promise<void> => {
  if (nativeLocalMediaMetadata?.writeLyric) {
    return nativeLocalMediaMetadata.writeLyric(filePath, lyric)
  }
  throw unsupportedError
}

export const readPic = async(dirPath: string): Promise<string> => {
  if (!nativeLocalMediaMetadata?.readPic) throw unsupportedError
  if (!cleared) await clearPicCache()
  return nativeLocalMediaMetadata.readPic(dirPath, picCachePath)
}
