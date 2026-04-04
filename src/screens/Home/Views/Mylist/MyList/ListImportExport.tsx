import ChoosePath, { type ChoosePathType } from '@/components/common/ChoosePath'
import { LXM_FILE_EXT_RXP } from '@/config/constant'
import { Platform } from 'react-native'
import { forwardRef, useImperativeHandle, useRef } from 'react'
import { handleExport, handleImport, handleImportMediaFile } from './listAction'
import { toast } from '@/utils/tools'

export interface SelectInfo {
  listInfo: LX.List.MyListInfo
  // selectedList: LX.Music.MusicInfo[]
  index: number
  // listId: string
  // single: boolean
  action: 'import' | 'export' | 'selectFile'
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
  import: (listInfo: LX.List.MyListInfo, index: number) => void
  export: (listInfo: LX.List.MyListInfo, index: number) => void
  selectFile: (listInfo: LX.List.MyListInfo, index: number) => void
}

export default forwardRef<ListImportExportType, {}>((props, ref) => {
  const choosePathRef = useRef<ChoosePathType>(null)
  const selectInfoRef = useRef<SelectInfo>((initSelectInfo as SelectInfo))
  // console.log('render import export')

  const showChoosePath = (action: SelectInfo['action']) => {
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
      case 'selectFile':
        choosePathRef.current.show({
          title: global.i18n.t('list_select_local_file_desc'),
          dirOnly: true,
          isPersist: true,
        })
        break
    }
  }

  useImperativeHandle(ref, () => ({
    import(listInfo, index) {
      selectInfoRef.current = {
        action: 'import',
        listInfo,
        index,
      }
      showChoosePath('import')
    },
    export(listInfo, index) {
      selectInfoRef.current = {
        action: 'export',
        listInfo,
        index,
      }
      if (Platform.OS == 'ios') {
        handleExport(listInfo)
        return
      }
      showChoosePath('export')
    },
    selectFile(listInfo, index) {
      selectInfoRef.current = {
        action: 'selectFile',
        listInfo,
        index,
      }
      if (Platform.OS == 'ios') {
        toast(global.i18n.t('platform_feature_not_supported'), 'long')
        return
      }
      showChoosePath('selectFile')
    },
  }))


  const onConfirmPath = (path: string) => {
    switch (selectInfoRef.current.action) {
      case 'import':
        handleImport(path, selectInfoRef.current.index)
        break
      case 'export':
        handleExport(selectInfoRef.current.listInfo, path)
        break
      case 'selectFile':
        void handleImportMediaFile(selectInfoRef.current.listInfo, path)
        break
    }
  }

  return (
    <ChoosePath ref={choosePathRef} onConfirm={onConfirmPath} />
  )
})
