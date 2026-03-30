import ChoosePath, { type ChoosePathType } from '@/components/common/ChoosePath'
import { LXM_FILE_EXT_RXP } from '@/config/constant'
import { Platform } from 'react-native'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { handleExportList, handleImportList } from './actions'

export interface SelectInfo {
  // listInfo: LX.List.MyListInfo
  // selectedList: LX.Music.MusicInfo[]
  // index: number
  // listId: string
  // single: boolean
  action: 'import' | 'export'
}
const initSelectInfo = {}

// export interface ListImportExportProps {
//   // onRename: (listInfo: LX.List.UserListInfo) => void
//   // onImport: (index: number) => void
//   // onExport: (listInfo: LX.List.MyListInfo) => void
//   // onSync: (listInfo: LX.List.UserListInfo) => void
//   // onRemove: (listInfo: LX.List.MyListInfo) => void
// }
export interface ListImportExportType {
  import: () => void
  export: () => void
}

export default forwardRef<ListImportExportType, {}>((props, ref) => {
  const [visible, setVisible] = useState(false)
  const choosePathRef = useRef<ChoosePathType>(null)
  const selectInfoRef = useRef<SelectInfo>((initSelectInfo as SelectInfo))
  const pendingShowRef = useRef<SelectInfo['action'] | null>(null)
  console.log('render import export')

  useEffect(() => {
    if (!visible || !pendingShowRef.current || !choosePathRef.current) return
    const action = pendingShowRef.current
    pendingShowRef.current = null
    switch (action) {
      case 'import':
        choosePathRef.current.show({
          title: global.i18n.t('list_import_part_desc'),
          dirOnly: false,
          filter: LXM_FILE_EXT_RXP,
        })
        break
      case 'export':
        choosePathRef.current.show({
          title: global.i18n.t('list_export_part_desc'),
          dirOnly: true,
          filter: LXM_FILE_EXT_RXP,
        })
        break
    }
  }, [visible])

  useImperativeHandle(ref, () => ({
    import() {
      selectInfoRef.current.action = 'import'
      if (visible) {
        choosePathRef.current?.show({
          title: global.i18n.t('list_import_part_desc'),
          dirOnly: false,
          filter: LXM_FILE_EXT_RXP,
        })
      } else {
        pendingShowRef.current = 'import'
        setVisible(true)
      }
    },
    export() {
      selectInfoRef.current.action = 'export'
      if (Platform.OS == 'ios') {
        handleExportList()
        return
      }
      if (visible) {
        choosePathRef.current?.show({
          title: global.i18n.t('list_export_part_desc'),
          dirOnly: true,
          filter: LXM_FILE_EXT_RXP,
        })
      } else {
        pendingShowRef.current = 'export'
        setVisible(true)
      }
    },
  }))


  const onConfirmPath = (path: string) => {
    switch (selectInfoRef.current.action) {
      case 'import':
        handleImportList(path)
        break
      case 'export':
        handleExportList(path)
        break
    }
  }

  return (
    visible
      ? <ChoosePath ref={choosePathRef} onConfirm={onConfirmPath} />
      : null
  )
})
