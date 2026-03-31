import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import { createStyle } from '@/utils/tools'

import LeftBar, { type LeftBarType, type LeftBarProps } from './LeftBar'
import MusicList, { type MusicListType } from '../MusicList'
import { getLeaderboardSetting, saveLeaderboardSetting } from '@/utils/data'
import { getBoardsList } from '@/core/leaderboard'
import { type BoardItem } from '@/store/leaderboard/state'
// import { BorderWidths } from '@/theme'
// import { useTheme } from '@/store/theme/hook'


export default () => {
  const leftBarRef = useRef<LeftBarType>(null)
  const musicListRef = useRef<MusicListType>(null)
  const isUnmountedRef = useRef(false)
  // const theme = useTheme()

  const resolveBoardId = (list: BoardItem[], boardId: string | null) => {
    if (!list.length) return null
    return list.some(item => item.id == boardId) ? boardId : list[0].id
  }

  const handleChangeBound: LeftBarProps['onChangeList'] = (source, id) => {
    musicListRef.current?.loadList(source, id)
    void saveLeaderboardSetting({
      source,
      boardId: id,
    })
  }

  useEffect(() => {
    isUnmountedRef.current = false
    void getLeaderboardSetting().then(({ source, boardId }) => {
      void getBoardsList(source).then(list => {
        const resolvedId = resolveBoardId(list, boardId)
        if (!resolvedId) return
        leftBarRef.current?.setBound(source, resolvedId)
        musicListRef.current?.loadList(source, resolvedId)
        if (resolvedId != boardId) {
          void saveLeaderboardSetting({
            source,
            boardId: resolvedId,
          })
        }
      })
    })

    return () => {
      isUnmountedRef.current = true
    }
  }, [])


  return (
    <View style={styles.container}>
      <LeftBar
        ref={leftBarRef}
        onChangeList={handleChangeBound}
      />
      <MusicList
        ref={musicListRef}
      />
    </View>
  )
}

const styles = createStyle({
  container: {
    width: '100%',
    flex: 1,
    flexDirection: 'row',
    // borderTopWidth: BorderWidths.normal,
  },
  content: {
    flex: 1,
  },
})
