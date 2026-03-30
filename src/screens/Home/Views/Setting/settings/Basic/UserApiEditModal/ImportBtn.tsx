import { useMemo } from 'react'
import { ActionSheetIOS, Platform, TouchableOpacity } from 'react-native'

import DorpDownMenu, { type DorpDownMenuProps as _DorpDownMenuProps } from '@/components/common/DorpDownMenu'
import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import { state } from '@/store/userApi'
import { tipDialog } from '@/utils/tools'

import { useTheme } from '@/store/theme/hook'

interface BtnProps {
  btnStyle?: _DorpDownMenuProps<any[]>['btnStyle']
  onImportAction?: (action: 'local' | 'online') => void
}


export default ({ btnStyle, onImportAction }: BtnProps) => {
  const t = useI18n()
  const theme = useTheme()

  const importTypes = useMemo(() => {
    return [
      { action: 'local', label: t('user_api_btn_import_local') },
      { action: 'online', label: t('user_api_btn_import_online') },
    ] as const
  }, [t])

  type DorpDownMenuProps = _DorpDownMenuProps<typeof importTypes>

  const handleImportAction = (action: 'local' | 'online') => {
    if (state.list.length > 20) {
      void tipDialog({
        message: t('user_api_max_tip'),
        btnText: t('ok'),
      })
      return
    }

    onImportAction?.(action)
  }

  const handleAction: DorpDownMenuProps['onPress'] = ({ action }) => {
    handleImportAction(action)
  }

  const handleShowActionSheet = () => {
    ActionSheetIOS.showActionSheetWithOptions({
      options: [
        t('user_api_btn_import_local'),
        t('user_api_btn_import_online'),
        t('cancel'),
      ],
      cancelButtonIndex: 2,
    }, index => {
      switch (index) {
        case 0:
          handleImportAction('local')
          break
        case 1:
          handleImportAction('online')
          break
      }
    })
  }

  if (Platform.OS == 'ios') {
    return (
      <TouchableOpacity style={btnStyle} onPress={handleShowActionSheet}>
        <Text size={14} color={theme['c-button-font']}>{t('user_api_btn_import')}</Text>
      </TouchableOpacity>
    )
  }

  return (
    <DorpDownMenu
      btnStyle={btnStyle}
      menus={importTypes}
      center
      onPress={handleAction}
    >
      <Text size={14} color={theme['c-button-font']}>{t('user_api_btn_import')}</Text>
    </DorpDownMenu>
  )
}
