import pako from 'pako'
import { createDecryptSchedules, desCrypt } from './customDes'

const DES_BLOCK_SIZE = 8
const DECRYPT_SCHEDULES = createDecryptSchedules()

const hexToUint8Array = hex => Buffer.from(hex, 'hex')

const decryptBlock = (input, output) => {
  const temp1 = new Uint8Array(8)
  const temp2 = new Uint8Array(8)
  desCrypt(input, temp1, DECRYPT_SCHEDULES[0])
  desCrypt(temp1, temp2, DECRYPT_SCHEDULES[1])
  desCrypt(temp2, output, DECRYPT_SCHEDULES[2])
}

const decompress = data => {
  const decompressed = pako.inflate(data)
  if (decompressed.length >= 3 &&
    decompressed[0] == 0xef &&
    decompressed[1] == 0xbb &&
    decompressed[2] == 0xbf) {
    return decompressed.slice(3)
  }
  return decompressed
}

export const decryptQrc = encryptedHexString => {
  if (!encryptedHexString) return ''
  const encryptedBytes = hexToUint8Array(encryptedHexString)
  if (encryptedBytes.length % DES_BLOCK_SIZE !== 0) {
    throw new Error(`Invalid encrypted qrc length: ${encryptedBytes.length}`)
  }

  const decryptedData = new Uint8Array(encryptedBytes.length)
  for (let i = 0; i < encryptedBytes.length; i += DES_BLOCK_SIZE) {
    const chunk = encryptedBytes.subarray(i, i + DES_BLOCK_SIZE)
    const outChunk = decryptedData.subarray(i, i + DES_BLOCK_SIZE)
    decryptBlock(chunk, outChunk)
  }

  return Buffer.from(decompress(decryptedData)).toString('utf8')
}
