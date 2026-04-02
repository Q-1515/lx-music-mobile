type MusicLyricInfo = Pick<LX.Player.MusicInfo, 'lrc' | 'lxlrc' | 'tlrc' | 'rlrc'>

const hasLyricText = (text?: string | null): text is string => {
  return typeof text == 'string' && text.trim().length > 0
}

export const getMainLyricText = (musicInfo: MusicLyricInfo) => {
  if (hasLyricText(musicInfo.lxlrc)) return musicInfo.lxlrc
  if (hasLyricText(musicInfo.lrc)) return musicInfo.lrc
  return ''
}

export const getLyricPayload = (musicInfo: MusicLyricInfo) => {
  return {
    lyric: getMainLyricText(musicInfo),
    tlrc: hasLyricText(musicInfo.tlrc) ? musicInfo.tlrc : '',
    rlrc: hasLyricText(musicInfo.rlrc) ? musicInfo.rlrc : '',
  }
}
