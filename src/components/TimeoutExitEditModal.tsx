import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ScrollView, Switch, View } from 'react-native'
import Modal, { type ModalType } from '@/components/common/Modal'
import Button from '@/components/common/Button'
import Input, { type InputType } from '@/components/common/Input'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { createStyle, toast } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import {
  cancelTimeoutExit,
  startSmartTimeoutExit,
  startTimeoutExit,
  stopSmartTimeoutExit,
  stopTimeoutExit,
  useTimeoutExitTimeInfo,
} from '@/core/player/timeoutExit'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import settingState from '@/store/setting/state'
import { isSmartSleepCloseSupported } from '@/utils/nativeModules/smartSleepClose'

const PRESET_MINUTES = [15, 30, 60, 90] as const
const MAX_MIN = 1440
const timeInputRxp = /([1-9]\d*)/

const formatTime = (time: number) => {
  const safeTime = Math.max(time, 0)
  const h = Math.trunc(safeTime / 3600)
  const m = Math.trunc((safeTime % 3600) / 60).toString().padStart(2, '0')
  const s = Math.trunc(safeTime % 60).toString().padStart(2, '0')
  return `${h.toString().padStart(2, '0')}:${m}:${s}`
}

type TimeoutOption = 'off' | 'smart' | number | 'custom'

const resolveActiveOption = (timeInfo: ReturnType<typeof useTimeInfo>, customMinutes: string): TimeoutOption => {
  if (timeInfo.mode == 'smart') return 'smart'
  if (timeInfo.mode != 'timer' || timeInfo.time < 0) return 'off'

  const totalMinutes = Math.max(Math.round(timeInfo.time / 60), 0)
  if ((PRESET_MINUTES as readonly number[]).includes(totalMinutes)) return totalMinutes
  if (customMinutes && parseInt(customMinutes) == totalMinutes) return 'custom'
  return totalMinutes > 0 ? 'custom' : 'off'
}

const Radio = ({ active }: { active: boolean }) => {
  const theme = useTheme()
  return (
    <View style={{
      ...styles.radio,
      borderColor: active ? theme['c-primary'] : theme['c-border-background'],
      backgroundColor: active ? theme['c-primary'] : 'transparent',
    }}>
      {active ? <View style={{ ...styles.radioInner, backgroundColor: theme['c-button-font'] }} /> : null}
    </View>
  )
}

const SectionTitle = ({ title }: { title: string }) => {
  const theme = useTheme()
  return <Text style={styles.sectionTitle} color={theme['c-font-label']}>{title}</Text>
}

const cardShadow = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 10 },
  shadowOpacity: 0.08,
  shadowRadius: 20,
  elevation: 4,
} as const

const OptionRow = ({
  label,
  desc,
  active,
  onPress,
  borderless = false,
}: {
  label: string
  desc?: string
  active: boolean
  onPress: () => void
  borderless?: boolean
}) => {
  const theme = useTheme()
  return (
    <Button
      onPress={onPress}
      style={{
        ...styles.optionRow,
        borderBottomColor: borderless ? 'transparent' : theme['c-border-background'],
      }}
    >
      <View style={styles.optionText}>
        <Text size={16}>{label}</Text>
        {desc ? <Text style={styles.optionDesc} size={13} color={theme['c-font-label']}>{desc}</Text> : null}
      </View>
      <Radio active={active} />
    </Button>
  )
}

const StatusCard = ({ timeInfo }: { timeInfo: ReturnType<typeof useTimeInfo> }) => {
  const theme = useTheme()
  const t = useI18n()

  const statusLabel = timeInfo.isPlayedStop
    ? t('timeout_exit_btn_wait_tip')
    : timeInfo.mode == 'smart'
      ? t(timeInfo.smartState == 'collecting_motion' ? 'timeout_exit_tip_smart_collecting' : 'timeout_exit_tip_smart_waiting')
      : timeInfo.mode == 'timer' && timeInfo.time >= 0
        ? t('timeout_exit_status_on')
        : t('timeout_exit_status_off')

  return (
    <View style={{ ...styles.statusCard, ...cardShadow, backgroundColor: theme['c-content-background'] }}>
      {
        timeInfo.mode == 'smart'
          ? (
              <>
                <View style={{ ...styles.smartBadge, backgroundColor: theme['c-primary-alpha-900'] }}>
                  <Icon name="music_time" color={theme['c-button-font']} size={18} />
                </View>
                <Text size={24} style={styles.statusTitle}>{t('timeout_exit_smart_title')}</Text>
                <Text size={14} color={theme['c-font-label']}>{statusLabel}</Text>
              </>
            )
          : (
              <>
                <Text style={styles.countdownText} color={theme['c-font-label']}>{formatTime(timeInfo.time > -1 ? timeInfo.time : 0)}</Text>
                <Text size={16} color={theme['c-font-label']}>{statusLabel}</Text>
              </>
            )
      }
    </View>
  )
}

export const useTimeInfo = useTimeoutExitTimeInfo

export interface TimeoutExitEditModalType {
  show: () => void
}

interface TimeoutExitEditModalProps {
  timeInfo: ReturnType<typeof useTimeInfo>
}

export default forwardRef<TimeoutExitEditModalType, TimeoutExitEditModalProps>(({ timeInfo }, ref) => {
  const theme = useTheme()
  const t = useI18n()
  const modalRef = useRef<ModalType>(null)
  const customInputRef = useRef<InputType>(null)
  const [visible, setVisible] = useState(false)
  const [customMinutes, setCustomMinutes] = useState(settingState.setting['player.timeoutExit'] || '')
  const timeoutExitPlayed = useSettingValue('player.timeoutExitPlayed')

  useEffect(() => {
    if (!visible) return
    setCustomMinutes(settingState.setting['player.timeoutExit'] || '')
  }, [visible])

  useImperativeHandle(ref, () => ({
    show() {
      setVisible(true)
      requestAnimationFrame(() => {
        modalRef.current?.setVisible(true)
      })
    },
  }))

  const hide = () => {
    modalRef.current?.setVisible(false)
  }

  const activeOption = useMemo(() => resolveActiveOption(timeInfo, customMinutes), [customMinutes, timeInfo])

  const stopAllModes = () => {
    cancelTimeoutExit()
    stopTimeoutExit()
    stopSmartTimeoutExit()
  }

  const handleSelectOff = () => {
    stopAllModes()
    toast(t('timeout_exit_tip_cancel'))
  }

  const handleSelectPreset = (minutes: number) => {
    stopAllModes()
    startTimeoutExit(minutes * 60)
    updateSetting({ 'player.timeoutExit': String(minutes) })
    setCustomMinutes(String(minutes))
    toast(t('timeout_exit_tip_on', { time: formatTime(minutes * 60) }))
  }

  const handleSelectSmart = () => {
    if (!isSmartSleepCloseSupported()) {
      toast(t('timeout_exit_tip_smart_unsupported'))
      return
    }
    stopAllModes()
    startSmartTimeoutExit()
    toast(t('timeout_exit_tip_smart_on'))
  }

  const handleApplyCustom = () => {
    let timeStr = customMinutes.trim()
    if (!timeInputRxp.test(timeStr)) {
      if (timeStr.length) toast(t('input_error'))
      return
    }
    timeStr = RegExp.$1
    const minutes = parseInt(timeStr)
    if (minutes > MAX_MIN) {
      toast(t('timeout_exit_tip_max', { num: MAX_MIN }))
      return
    }
    stopAllModes()
    startTimeoutExit(minutes * 60)
    updateSetting({ 'player.timeoutExit': String(minutes) })
    setCustomMinutes(String(minutes))
    toast(t('timeout_exit_tip_on', { time: formatTime(minutes * 60) }))
  }

  const handleToggleFinishCurrent = (value: boolean) => {
    updateSetting({ 'player.timeoutExitPlayed': value })
  }

  return (
    visible
      ? (
          <Modal ref={modalRef} onHide={() => { setVisible(false) }} bgColor="rgba(35, 35, 35, .32)">
            <View style={styles.mask}>
              <View style={{ ...styles.sheet, backgroundColor: theme['c-main-background'] }}>
                <View style={styles.header}>
                  <Button style={styles.headerBtn} onPress={hide}>
                    <Icon name="back-2" color={theme['c-font']} size={15} />
                  </Button>
                  <Text style={styles.headerTitle} size={18}>{t('timeout_exit_page_title')}</Text>
                  <View style={styles.headerBtn} />
                </View>

                <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="always">
                  <SectionTitle title={t('timeout_exit_section_countdown')} />
                  <StatusCard timeInfo={timeInfo} />

                  <SectionTitle title={t('timeout_exit_section_select')} />
                  <View style={{ ...styles.card, ...cardShadow, backgroundColor: theme['c-content-background'] }}>
                    <OptionRow label={t('timeout_exit_option_off')} active={activeOption == 'off'} onPress={handleSelectOff} />
                    {PRESET_MINUTES.map((minutes) => (
                      <OptionRow
                        key={minutes}
                        label={t('timeout_exit_option_minutes', { minutes })}
                        active={activeOption == minutes}
                        onPress={() => { handleSelectPreset(minutes) }}
                      />
                    ))}
                    <OptionRow label={t('timeout_exit_option_custom')} active={activeOption == 'custom'} onPress={() => { customInputRef.current?.focus() }} borderless />
                  </View>

                  <View style={{ ...styles.card, ...styles.customCard, ...cardShadow, backgroundColor: theme['c-content-background'] }}>
                    <Input
                      ref={customInputRef}
                      value={customMinutes}
                      onChangeText={setCustomMinutes}
                      keyboardType="number-pad"
                      placeholder={t('timeout_exit_input_tip')}
                      style={{ ...styles.customInput, backgroundColor: theme['c-primary-input-background'] }}
                    />
                    <Button style={{ ...styles.applyBtn, backgroundColor: theme['c-button-background'] }} onPress={handleApplyCustom}>
                      <Text color={theme['c-button-font']}>{t('confirm')}</Text>
                    </Button>
                  </View>

                  <View style={{ ...styles.card, ...cardShadow, backgroundColor: theme['c-content-background'] }}>
                    <OptionRow
                      label={t('timeout_exit_option_smart')}
                      desc={t('timeout_exit_option_smart_desc')}
                      active={activeOption == 'smart'}
                      onPress={handleSelectSmart}
                      borderless
                    />
                  </View>

                  <SectionTitle title={t('timeout_exit_section_other')} />
                  <View style={{ ...styles.card, ...styles.switchCard, ...cardShadow, backgroundColor: theme['c-content-background'] }}>
                    <View style={styles.switchText}>
                      <Text size={16}>{t('timeout_exit_label_isPlayed')}</Text>
                      <Text style={styles.optionDesc} size={13} color={theme['c-font-label']}>{t('timeout_exit_label_isPlayed_desc')}</Text>
                    </View>
                    <Switch
                      value={timeoutExitPlayed}
                      onValueChange={handleToggleFinishCurrent}
                      trackColor={{ false: theme['c-primary-light-400-alpha-300'], true: theme['c-primary-alpha-800'] }}
                      thumbColor={theme['c-button-font']}
                      ios_backgroundColor={theme['c-primary-light-400-alpha-300']}
                    />
                  </View>
                </ScrollView>
              </View>
            </View>
          </Modal>
        )
      : null
  )
})

const styles = createStyle({
  mask: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    minHeight: '72%',
    maxHeight: '88%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 18,
    paddingBottom: 10,
    paddingHorizontal: 18,
  },
  headerBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontWeight: 600,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingBottom: 26,
  },
  sectionTitle: {
    marginTop: 12,
    marginBottom: 10,
  },
  card: {
    borderRadius: 18,
    overflow: 'hidden',
  },
  statusCard: {
    minHeight: 140,
    borderRadius: 18,
    paddingHorizontal: 22,
    paddingVertical: 22,
    justifyContent: 'center',
  },
  countdownText: {
    fontSize: 34,
    lineHeight: 40,
    marginBottom: 10,
    fontVariant: ['tabular-nums'],
  },
  statusTitle: {
    marginBottom: 8,
    fontWeight: 600,
    paddingRight: 72,
  },
  smartBadge: {
    position: 'absolute',
    right: 22,
    top: 22,
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionRow: {
    minHeight: 68,
    paddingHorizontal: 20,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
  },
  optionText: {
    flexGrow: 1,
    flexShrink: 1,
    paddingRight: 16,
  },
  optionDesc: {
    marginTop: 4,
  },
  radio: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  customCard: {
    marginTop: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  customInput: {
    flexGrow: 1,
    flexShrink: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 42,
    marginRight: 10,
  },
  applyBtn: {
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 72,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  switchCard: {
    minHeight: 88,
    paddingHorizontal: 20,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  switchText: {
    flexGrow: 1,
    flexShrink: 1,
    paddingRight: 16,
  },
})
