const lxWordTimeTagRxp = /<[-\d]+,[-\d]+(?:,[-\d]+)?>/g
const qrcWordTimeTagRxp = /\(\d+,\d+(?:,\d+)?\)/g

export const normalizeExtendedLyricText = (text: string) => {
  return text
    .replace(lxWordTimeTagRxp, '')
    .replace(qrcWordTimeTagRxp, '')
    .trim()
}
