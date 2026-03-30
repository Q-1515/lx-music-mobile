import ChoosePath, { type ChoosePathType } from '@/components/common/ChoosePath'
import { USER_API_SOURCE_FILE_EXT_RXP } from '@/config/constant'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { handleImportLocalFile } from './action'

export interface SelectInfo {
  // listInfo: LX.List.MyListInfo
  // selectedList: LX.Music.MusicInfo[]
  // index: number
  // listId: string
  // single: boolean
  action: 'import'
}
const initSelectInfo = {}

// export interface ScriptImportExportProps {
//   // onRename: (listInfo: LX.List.UserListInfo) => void
//   // onImport: (index: number) => void
//   // onExport: (listInfo: LX.List.MyListInfo) => void
//   // onSync: (listInfo: LX.List.UserListInfo) => void
//   // onRemove: (listInfo: LX.List.MyListInfo) => void
// }
export interface ScriptImportExportType {
  import: () => void
  // export: (listInfo: LX.List.MyListInfo, index: number) => void
}

export default forwardRef<ScriptImportExportType, {}>((props, ref) => {
  const [visible, setVisible] = useState(false)
  const choosePathRef = useRef<ChoosePathType>(null)
  const selectInfoRef = useRef<SelectInfo>((initSelectInfo as SelectInfo))
  const pendingShowRef = useRef(false)
  // console.log('render import export')

  useEffect(() => {
    if (!visible || !pendingShowRef.current || !choosePathRef.current) return
    pendingShowRef.current = false
    choosePathRef.current.show({
      title: global.i18n.t('user_api_import_desc'),
      dirOnly: false,
      filter: USER_API_SOURCE_FILE_EXT_RXP,
    })
  }, [visible])

  useImperativeHandle(ref, () => ({
    import() {
      selectInfoRef.current = {
        action: 'import',
      }
      if (visible) {
        choosePathRef.current?.show({
          title: global.i18n.t('user_api_import_desc'),
          dirOnly: false,
          filter: USER_API_SOURCE_FILE_EXT_RXP,
        })
      } else {
        pendingShowRef.current = true
        setVisible(true)
      }
    },
    // export(listInfo, index) {
    //   selectInfoRef.current = {
    //     action: 'export',
    //     listInfo,
    //     index,
    //   }
    //   if (visible) {
    //     choosePathRef.current?.show({
    //       title: global.i18n.t('list_export_part_desc'),
    //       dirOnly: true,
    //       filter: LXM_FILE_EXT_RXP,
    //     })
    //   } else {
    //     setVisible(true)
    //     requestAnimationFrame(() => {
    //       choosePathRef.current?.show({
    //         title: global.i18n.t('list_export_part_desc'),
    //         dirOnly: true,
    //         filter: LXM_FILE_EXT_RXP,
    //       })
    //     })
    //   }
    // },
  }))


  const onConfirmPath = (path: string) => {
    switch (selectInfoRef.current.action) {
      case 'import':
        handleImportLocalFile(path)
        break
      // case 'export':
      //   handleExport(selectInfoRef.current.listInfo, path)
      //   break
    }
  }

  return (
    visible
      ? <ChoosePath ref={choosePathRef} onConfirm={onConfirmPath} />
      : null
  )
})
