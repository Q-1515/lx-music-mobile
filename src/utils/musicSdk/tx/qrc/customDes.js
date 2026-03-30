import {
  E_BOX_TABLE,
  KEY_1,
  KEY_2,
  KEY_3,
  KEY_COMPRESSION,
  KEY_PERM_C,
  KEY_PERM_D,
  KEY_RND_SHIFT,
  P_BOX,
  S_BOXES,
} from './constants'

export const Mode = {
  Encrypt: 0,
  Decrypt: 1,
}

const permuteFromKeyBytes = (key, table) => {
  let output = 0n
  const outputLen = BigInt(table.length)
  for (let i = 0; i < table.length; i++) {
    const pos = table[i]
    const wordIndex = Math.floor(pos / 32)
    const bitInWord = pos % 32
    const byteInWord = Math.floor(bitInWord / 8)
    const bitInByte = bitInWord % 8
    const byteIndex = wordIndex * 4 + 3 - byteInWord
    const bit = (key[byteIndex] >> (7 - bitInByte)) & 1
    if (bit) output |= 1n << (outputLen - 1n - BigInt(i))
  }
  return output
}

const rotateLeft28Bit = (value, amount) => {
  const bits28Mask = 0xfffffff0n
  const val = value & bits28Mask
  const shifted = (val << BigInt(amount)) | (val >> BigInt(28 - amount))
  return shifted & bits28Mask
}

export const keySchedule = (key, mode) => {
  const schedule = Array.from({ length: 16 }, () => Array(6).fill(0))
  const c0 = permuteFromKeyBytes(key, KEY_PERM_C)
  const d0 = permuteFromKeyBytes(key, KEY_PERM_D)
  let c = c0 << 4n
  let d = d0 << 4n

  for (let i = 0; i < 16; i++) {
    const shift = KEY_RND_SHIFT[i]
    c = rotateLeft28Bit(c, shift)
    d = rotateLeft28Bit(d, shift)

    const toGen = mode === Mode.Decrypt ? 15 - i : i
    let subkey48bit = 0n
    for (let k = 0; k < KEY_COMPRESSION.length; k++) {
      const pos = KEY_COMPRESSION[k]
      const bitBigInt = pos < 28
        ? (c >> BigInt(31 - pos)) & 1n
        : (d >> BigInt(31 - (pos - 27))) & 1n
      if (bitBigInt === 1n) subkey48bit |= 1n << BigInt(47 - k)
    }

    const subkeyBytes = []
    for (let j = 5; j >= 0; j--) {
      subkeyBytes.push(Number((subkey48bit >> BigInt(j * 8)) & 0xffn))
    }
    schedule[toGen] = subkeyBytes
  }
  return schedule
}

const ipRule = [
  34, 42, 50, 58, 2, 10, 18, 26, 36, 44, 52, 60, 4, 12, 20, 28, 38, 46, 54, 62,
  6, 14, 22, 30, 40, 48, 56, 64, 8, 16, 24, 32, 33, 41, 49, 57, 1, 9, 17, 25,
  35, 43, 51, 59, 3, 11, 19, 27, 37, 45, 53, 61, 5, 13, 21, 29, 39, 47, 55, 63,
  7, 15, 23, 31,
]
const invIpRule = [
  37, 5, 45, 13, 53, 21, 61, 29, 38, 6, 46, 14, 54, 22, 62, 30, 39, 7, 47, 15,
  55, 23, 63, 31, 40, 8, 48, 16, 56, 24, 64, 32, 33, 1, 41, 9, 49, 17, 57, 25,
  34, 2, 42, 10, 50, 18, 58, 26, 35, 3, 43, 11, 51, 19, 59, 27, 36, 4, 44, 12,
  52, 20, 60, 28,
]

const generatePermutationTables = () => {
  const ipTable = Array.from({ length: 8 }, () => Array(256).fill([0, 0]))
  const invIpTable = Array.from({ length: 8 }, () => Array(256).fill(0n))
  const applyPermutation = (input, rule) => {
    let output = 0n
    for (let i = 0; i < 64; i++) {
      const srcBit1Based = rule[i]
      if ((input >> BigInt(64 - srcBit1Based)) & 1n) output |= 1n << BigInt(63 - i)
    }
    return output
  }

  for (let bytePos = 0; bytePos < 8; bytePos++) {
    for (let byteVal = 0; byteVal < 256; byteVal++) {
      const input = BigInt(byteVal) << BigInt(56 - bytePos * 8)
      const permuted = applyPermutation(input, ipRule)
      ipTable[bytePos][byteVal] = [
        Number((permuted >> 32n) & 0xffffffffn),
        Number(permuted & 0xffffffffn),
      ]
    }
  }

  for (let blockPos = 0; blockPos < 8; blockPos++) {
    for (let blockVal = 0; blockVal < 256; blockVal++) {
      const input = BigInt(blockVal) << BigInt(56 - blockPos * 8)
      invIpTable[blockPos][blockVal] = applyPermutation(input, invIpRule)
    }
  }

  return { ipTable, invIpTable }
}

const { ipTable: IP_TABLE, invIpTable: INV_IP_TABLE } = generatePermutationTables()

const calculateSboxIndex = a => (a & 0x20) | ((a & 0x1f) >> 1) | ((a & 0x01) << 4)

const applyQqPboxPermutation = input => {
  let output = 0
  for (let i = 0; i < 32; i++) {
    const sourceBit1Based = P_BOX[i]
    const destBitMask = 1 << (31 - i)
    const sourceBitMask = 1 << (32 - sourceBit1Based)
    if ((input & sourceBitMask) !== 0) output |= destBitMask
  }
  return output
}

const generateSpTables = () => {
  const spTables = Array.from({ length: 8 }, () => Array(64).fill(0))
  for (let sBoxIdx = 0; sBoxIdx < 8; sBoxIdx++) {
    for (let sBoxInput = 0; sBoxInput < 64; sBoxInput++) {
      const sBoxIndex = calculateSboxIndex(sBoxInput)
      const fourBitOutput = S_BOXES[sBoxIdx][sBoxIndex]
      const prePBoxVal = fourBitOutput << (28 - sBoxIdx * 4)
      spTables[sBoxIdx][sBoxInput] = applyQqPboxPermutation(prePBoxVal)
    }
  }
  return spTables
}

const SP_TABLES = generateSpTables()

const applyEBoxPermutation = input => {
  let output = 0n
  for (let i = 0; i < 48; i++) {
    const sourceBitPos = E_BOX_TABLE[i]
    const shiftAmount = 32 - sourceBitPos
    const bit = (input >> shiftAmount) & 1
    if (bit) output |= 1n << BigInt(47 - i)
  }
  return output
}

const fFunction = (state, key) => {
  const keyU64 = (BigInt(key[0]) << 40n) |
    (BigInt(key[1]) << 32n) |
    (BigInt(key[2]) << 24n) |
    (BigInt(key[3]) << 16n) |
    (BigInt(key[4]) << 8n) |
    BigInt(key[5])
  const xorResult = applyEBoxPermutation(state) ^ keyU64
  return (SP_TABLES[0][Number((xorResult >> 42n) & 0x3fn)] |
    SP_TABLES[1][Number((xorResult >> 36n) & 0x3fn)] |
    SP_TABLES[2][Number((xorResult >> 30n) & 0x3fn)] |
    SP_TABLES[3][Number((xorResult >> 24n) & 0x3fn)] |
    SP_TABLES[4][Number((xorResult >> 18n) & 0x3fn)] |
    SP_TABLES[5][Number((xorResult >> 12n) & 0x3fn)] |
    SP_TABLES[6][Number((xorResult >> 6n) & 0x3fn)] |
    SP_TABLES[7][Number(xorResult & 0x3fn)])
}

export const desCrypt = (input, output, schedule) => {
  let left = 0
  let right = 0
  for (let i = 0; i < 8; i++) {
    const [l, r] = IP_TABLE[i][input[i]]
    left |= l
    right |= r
  }

  for (let i = 0; i < 15; i++) {
    const temp = right
    right = (left ^ fFunction(right, schedule[i])) >>> 0
    left = temp
  }
  left = (left ^ fFunction(right, schedule[15])) >>> 0

  let result = 0n
  for (let i = 0; i < 4; i++) {
    result |= INV_IP_TABLE[i][(left >> (24 - i * 8)) & 0xff]
    result |= INV_IP_TABLE[i + 4][(right >> (24 - i * 8)) & 0xff]
  }
  for (let i = 0; i < 8; i++) {
    output[i] = Number((result >> BigInt(56 - i * 8)) & 0xffn)
  }
}

export const createDecryptSchedules = () => [
  keySchedule(KEY_3, Mode.Decrypt),
  keySchedule(KEY_2, Mode.Encrypt),
  keySchedule(KEY_1, Mode.Decrypt),
]
