import { useMemo } from 'react'
import { ActionSheetIOS, Platform } from 'react-native'

import DorpDownMenu, { type DorpDownMenuProps as _DorpDownMenuProps } from '@/components/common/DorpDownMenu'
import Button from '@/components/common/Button'
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

  const handleAction: DorpDownMenuProps['onPress'] = ({ action }) => {
    if (state.list.length > 20) {
      void tipDialog({
        message: t('user_api_max_tip'),
        btnText: t('ok'),
      })
      return
    }

    onImportAction?.(action)
  }

  const handlePress = () => {
    if (Platform.OS != 'ios') return
    if (state.list.length > 20) {
      void tipDialog({
        message: t('user_api_max_tip'),
        btnText: t('ok'),
      })
      return
    }

    setTimeout(() => {
      ActionSheetIOS.showActionSheetWithOptions({
        options: [
          t('user_api_btn_import_local'),
          t('user_api_btn_import_online'),
          t('close'),
        ],
        cancelButtonIndex: 2,
      }, (buttonIndex) => {
        if (buttonIndex === 0) {
          handleAction({ action: 'local', label: t('user_api_btn_import_local') })
        } else if (buttonIndex === 1) {
          handleAction({ action: 'online', label: t('user_api_btn_import_online') })
        }
      })
    }, 260)
  }


  return Platform.OS == 'ios'
    ? (
        <Button style={btnStyle} onPress={handlePress}>
          <Text size={14} color={theme['c-button-font']}>{t('user_api_btn_import')}</Text>
        </Button>
      )
    : (
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
