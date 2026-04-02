import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { FlatList, Platform, SafeAreaView, ScrollView, Switch, TouchableWithoutFeedback, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import Modal, { type ModalType } from '@/components/common/Modal'
import Button from '@/components/common/Button'
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
import { isSmartSleepCloseSupported } from '@/utils/nativeModules/smartSleepClose'
import { useStatusbarHeight } from '@/store/common/hook'
import { isNativeCountdownPickerSupported, openNativeCountdownPicker } from '@/utils/nativeModules/countdownPicker'

const PRESET_MINUTES = [15, 30, 60, 90] as const
const DEFAULT_CUSTOM_MINUTES = '10'
const MAX_MIN = 1440
const WHEEL_ITEM_HEIGHT = 54
const WHEEL_VISIBLE_ROWS = 5
const WHEEL_HEIGHT = WHEEL_ITEM_HEIGHT * WHEEL_VISIBLE_ROWS

type TimeoutOption = 'off' | 'smart' | number | 'custom'
type TimeoutTimerType = 'preset' | 'custom'

const HOURS = Array.from({ length: 25 }, (_, index) => index)
const MINUTES = Array.from({ length: 60 }, (_, index) => index)

const cardShadow = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 14 },
  shadowOpacity: 0.1,
  shadowRadius: 24,
  elevation: 6,
} as const

const getCardSurfaceStyle = (theme: ReturnType<typeof useTheme>) => ({
  ...cardShadow,
  backgroundColor: theme['c-content-background'],
  borderWidth: 1,
  borderColor: theme['c-border-background'],
}) as const

const formatClock = (time: number) => {
  const safeTime = Math.max(time, 0)
  const h = Math.trunc(safeTime / 3600)
  const m = Math.trunc((safeTime % 3600) / 60).toString().padStart(2, '0')
  const s = Math.trunc(safeTime % 60).toString().padStart(2, '0')
  return `${h.toString().padStart(2, '0')}:${m}:${s}`
}

const parsePositiveMinutes = (minutesText: string) => Math.max(parseInt(minutesText || '0') || 0, 0)
const isPresetMinutes = (minutes: number) => (PRESET_MINUTES as readonly number[]).includes(minutes)

const parseMinutes = (minutesText: string) => {
  const minutes = parsePositiveMinutes(minutesText)
  return {
    hours: Math.min(Math.trunc(minutes / 60), 24),
    minutes: Math.min(minutes % 60, 59),
  }
}

// TODO: remove after old custom label helper is fully deleted from follow-up cleanup.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const formatCustomLabel = (hours: number, minutes: number) => {
  return `${hours.toString().padStart(2, '0')} 小时 ${minutes.toString().padStart(2, '0')} 分钟`
}

const resolveStoredCustomMinutes = (customMinutes: string, timeoutMinutes: string, timerType: TimeoutTimerType) => {
  if (customMinutes) return customMinutes

  const totalMinutes = parsePositiveMinutes(timeoutMinutes)
  if (!totalMinutes) return ''
  if (timerType == 'custom' || !isPresetMinutes(totalMinutes)) return String(totalMinutes)
  return ''
}

const resolveActiveOption = (
  timeInfo: ReturnType<typeof useTimeInfo>,
  timeoutMinutes: string,
  timerType: TimeoutTimerType,
): TimeoutOption => {
  if (timeInfo.mode == 'smart') return 'smart'
  if (timeInfo.mode != 'timer') return 'off'

  const totalMinutes = parsePositiveMinutes(timeoutMinutes)
  if (!totalMinutes) return 'off'
  if (timerType == 'custom') return 'custom'
  if (isPresetMinutes(totalMinutes)) return totalMinutes
  return 'custom'
}

const Radio = ({ active }: { active: boolean }) => {
  const theme = useTheme()
  return (
    <View style={{
      ...styles.radio,
      borderColor: active ? theme['c-primary'] : theme['c-border-background'],
      backgroundColor: active ? theme['c-primary'] : 'transparent',
    }}>
      {active ? <View style={{ ...styles.radioInner, backgroundColor: theme['c-primary-light-1000'] }} /> : null}
    </View>
  )
}

const SectionTitle = ({ title }: { title: string }) => {
  const theme = useTheme()
  return <Text style={styles.sectionTitle} color={theme['c-font-label']}>{title}</Text>
}

const OptionRow = ({
  label,
  desc,
  valueText,
  active,
  onPress,
  borderless = false,
}: {
  label: string
  desc?: string
  valueText?: string
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
      <View style={styles.optionTrailing}>
        {valueText ? <Text style={styles.optionValue} size={14} color={theme['c-font-label']}>{valueText}</Text> : null}
        <Radio active={active} />
      </View>
    </Button>
  )
}

const StatusCard = ({ timeInfo }: { timeInfo: ReturnType<typeof useTimeInfo> }) => {
  const theme = useTheme()
  const t = useI18n()
  const cardStyle = useMemo(() => ({ ...styles.statusCard, ...getCardSurfaceStyle(theme) }), [theme])

  const statusLabel = timeInfo.isPlayedStop
    ? t('timeout_exit_btn_wait_tip')
    : timeInfo.mode == 'smart'
      ? t(timeInfo.smartState == 'collecting_motion' ? 'timeout_exit_tip_smart_collecting' : 'timeout_exit_tip_smart_waiting')
      : timeInfo.mode == 'timer' && timeInfo.time >= 0
        ? t('timeout_exit_status_on')
        : t('timeout_exit_status_off')

  return (
    <View style={cardStyle}>
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
                <Text style={styles.countdownText}>{formatClock(timeInfo.time > -1 ? timeInfo.time : 0)}</Text>
                <Text size={16} color={theme['c-font-label']}>{statusLabel}</Text>
              </>
            )
      }
    </View>
  )
}

const WheelColumn = ({
  list,
  selected,
  onSelect,
}: {
  list: number[]
  selected: number
  onSelect: (value: number) => void
}) => {
  const theme = useTheme()
  const flatListRef = useRef<FlatList<number>>(null)

  useEffect(() => {
    requestAnimationFrame(() => {
      flatListRef.current?.scrollToOffset({
        offset: selected * WHEEL_ITEM_HEIGHT,
        animated: false,
      })
    })
  }, [selected])

  const updateSelectedFromOffset = (offsetY: number) => {
    const rawIndex = Math.round(offsetY / WHEEL_ITEM_HEIGHT)
    const index = Math.min(Math.max(rawIndex, 0), list.length - 1)
    onSelect(list[index])
  }

  const handleMomentumScrollEnd = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    updateSelectedFromOffset(nativeEvent.contentOffset.y)
  }

  const handleScrollEndDrag = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    updateSelectedFromOffset(nativeEvent.contentOffset.y)
  }

  const renderItem = ({ item }: { item: number }) => {
    const active = item == selected
    return (
      <View style={styles.wheelItem}>
        <Text size={active ? 20 : 17} color={active ? theme['c-font'] : theme['c-font-label']}>{item.toString().padStart(2, '0')}</Text>
      </View>
    )
  }

  return (
    <FlatList
      ref={flatListRef}
      data={list}
      renderItem={renderItem}
      keyExtractor={(item) => String(item)}
      showsVerticalScrollIndicator={false}
      nestedScrollEnabled
      snapToInterval={WHEEL_ITEM_HEIGHT}
      decelerationRate="fast"
      getItemLayout={(_, index) => ({ length: WHEEL_ITEM_HEIGHT, offset: WHEEL_ITEM_HEIGHT * index, index })}
      contentContainerStyle={styles.wheelContent}
      style={styles.wheelList}
      onMomentumScrollEnd={handleMomentumScrollEnd}
      onScrollEndDrag={handleScrollEndDrag}
    />
  )
}

const CustomTimePicker = ({
  visible,
  hours,
  minutes,
  onClose,
  onConfirm,
  onChangeHours,
  onChangeMinutes,
}: {
  visible: boolean
  hours: number
  minutes: number
  onClose: () => void
  onConfirm: () => void
  onChangeHours: (value: number) => void
  onChangeMinutes: (value: number) => void
}) => {
  const theme = useTheme()
  const t = useI18n()
  if (!visible) return null

  return (
    <View style={styles.pickerMask} pointerEvents="box-none">
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.pickerBackdrop} />
      </TouchableWithoutFeedback>
      <SafeAreaView style={{ ...styles.pickerPanel, ...getCardSurfaceStyle(theme) }}>
        <View style={styles.pickerHeader}>
          <Text style={styles.pickerTitle} size={17}>{t('timeout_exit_custom_picker_title')}</Text>
          <Button style={{ ...styles.pickerConfirmBtn, backgroundColor: theme['c-primary'] }} onPress={onConfirm}>
            <Text color={theme['c-primary-light-1000']} size={15}>{t('confirm')}</Text>
          </Button>
        </View>
        <View style={styles.pickerBody}>
          <View style={styles.wheelOverlay} pointerEvents="none">
            <View style={{ ...styles.wheelOverlayHighlight, backgroundColor: theme['c-primary-input-background'] }} />
          </View>
          <View style={styles.wheelColumnWrap}>
            <WheelColumn list={HOURS} selected={hours} onSelect={onChangeHours} />
            <Text style={styles.wheelLabel} size={18}>{t('timeout_exit_hour')}</Text>
          </View>
          <View style={styles.wheelColumnWrap}>
            <WheelColumn list={MINUTES} selected={minutes} onSelect={onChangeMinutes} />
            <Text style={styles.wheelLabel} size={18}>{t('timeout_exit_min')}</Text>
          </View>
        </View>
      </SafeAreaView>
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
  const [visible, setVisible] = useState(false)
  const [customPickerVisible, setCustomPickerVisible] = useState(false)
  const statusBarHeight = useStatusbarHeight()
  const timeoutExitMinutes = useSettingValue('player.timeoutExit')
  const timeoutExitCustomMinutes = useSettingValue('player.timeoutExitCustomMinutes')
  const timeoutExitTimerType = useSettingValue('player.timeoutExitTimerType')
  const storedCustomMinutes = useMemo(
    () => resolveStoredCustomMinutes(timeoutExitCustomMinutes, timeoutExitMinutes, timeoutExitTimerType),
    [timeoutExitCustomMinutes, timeoutExitMinutes, timeoutExitTimerType],
  )
  const [pickerHours, setPickerHours] = useState(() => parseMinutes(storedCustomMinutes || DEFAULT_CUSTOM_MINUTES).hours)
  const [pickerMinutes, setPickerMinutes] = useState(() => parseMinutes(storedCustomMinutes || DEFAULT_CUSTOM_MINUTES).minutes)
  const timeoutExitPlayed = useSettingValue('player.timeoutExitPlayed')
  const cardSurfaceStyle = useMemo(() => getCardSurfaceStyle(theme), [theme])

  useEffect(() => {
    if (!visible) return
    const { hours, minutes } = parseMinutes(storedCustomMinutes || DEFAULT_CUSTOM_MINUTES)
    setPickerHours(hours)
    setPickerMinutes(minutes)
  }, [storedCustomMinutes, visible])

  useImperativeHandle(ref, () => ({
    show() {
      setVisible(true)
      requestAnimationFrame(() => {
        modalRef.current?.setVisible(true)
      })
    },
  }))

  const hide = () => {
    setCustomPickerVisible(false)
    modalRef.current?.setVisible(false)
  }

  const activeOption = useMemo(
    () => resolveActiveOption(timeInfo, timeoutExitMinutes, timeoutExitTimerType),
    [timeInfo, timeoutExitMinutes, timeoutExitTimerType],
  )

  const stopAllModes = () => {
    cancelTimeoutExit()
    stopTimeoutExit()
    stopSmartTimeoutExit()
  }

  const applyCustomMinutes = (totalMinutes: number) => {
    if (!totalMinutes || totalMinutes > MAX_MIN) {
      toast(t('timeout_exit_tip_max', { num: MAX_MIN }))
      return
    }
    stopAllModes()
    startTimeoutExit(totalMinutes * 60)
    updateSetting({
      'player.timeoutExit': String(totalMinutes),
      'player.timeoutExitCustomMinutes': String(totalMinutes),
      'player.timeoutExitTimerType': 'custom',
    })
    setCustomPickerVisible(false)
    toast(t('timeout_exit_tip_on', { time: formatClock(totalMinutes * 60) }))
  }

  const handleSelectOff = () => {
    stopAllModes()
    toast(t('timeout_exit_tip_cancel'))
  }

  const handleSelectPreset = (minutes: number) => {
    stopAllModes()
    startTimeoutExit(minutes * 60)
    updateSetting({
      'player.timeoutExit': String(minutes),
      'player.timeoutExitTimerType': 'preset',
    })
    toast(t('timeout_exit_tip_on', { time: formatClock(minutes * 60) }))
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

  const handleOpenCustomPicker = async() => {
    const sourceMinutes = storedCustomMinutes || DEFAULT_CUSTOM_MINUTES
    const parsed = parseMinutes(sourceMinutes)
    if (Platform.OS == 'ios' && isNativeCountdownPickerSupported()) {
      const totalMinutes = await openNativeCountdownPicker({
        minutes: parsePositiveMinutes(sourceMinutes) || parsePositiveMinutes(DEFAULT_CUSTOM_MINUTES),
        maxMinutes: MAX_MIN,
        title: t('timeout_exit_custom_picker_title'),
        confirmTitle: t('confirm'),
        cancelTitle: t('cancel'),
        hourTitle: t('timeout_exit_hour'),
        minuteTitle: t('timeout_exit_min'),
      })
      if (totalMinutes == null) return
      applyCustomMinutes(totalMinutes)
      return
    }
    setPickerHours(parsed.hours)
    setPickerMinutes(parsed.minutes)
    setCustomPickerVisible(true)
  }

  const handleApplyCustom = () => {
    applyCustomMinutes(pickerHours * 60 + pickerMinutes)
  }

  const handleToggleFinishCurrent = (value: boolean) => {
    updateSetting({ 'player.timeoutExitPlayed': value })
  }

  const customValueText = useMemo(() => {
    if (!storedCustomMinutes) return t('timeout_exit_option_custom_placeholder')
    const { hours, minutes } = parseMinutes(storedCustomMinutes)
    return `${hours.toString().padStart(2, '0')} ${t('timeout_exit_hour')} ${minutes.toString().padStart(2, '0')} ${t('timeout_exit_min')}`
  }, [storedCustomMinutes, t])

  return (
    visible
      ? (
          <Modal ref={modalRef} onHide={() => { setVisible(false) }} bgColor={theme['c-main-background']} bgHide={false}>
            <View style={styles.mask}>
              <SafeAreaView style={{ ...styles.sheet, backgroundColor: theme['c-main-background'] }}>
                <View style={{ ...styles.header, paddingTop: 10 + statusBarHeight }}>
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
                  <View style={{ ...styles.card, ...cardSurfaceStyle }}>
                    <OptionRow label={t('timeout_exit_option_off')} active={activeOption == 'off'} onPress={handleSelectOff} />
                    {PRESET_MINUTES.map((minutes) => (
                      <OptionRow
                        key={minutes}
                        label={t('timeout_exit_option_minutes', { minutes })}
                        active={activeOption == minutes}
                        onPress={() => { handleSelectPreset(minutes) }}
                      />
                    ))}
                    <OptionRow
                      label={t('timeout_exit_option_custom')}
                      valueText={customValueText}
                      active={activeOption == 'custom'}
                      onPress={() => { void handleOpenCustomPicker() }}
                    />
                    <OptionRow
                      label={t('timeout_exit_option_smart')}
                      desc={t('timeout_exit_option_smart_desc')}
                      active={activeOption == 'smart'}
                      onPress={handleSelectSmart}
                      borderless
                    />
                  </View>

                  <SectionTitle title={t('timeout_exit_section_other')} />
                  <View style={{ ...styles.card, ...styles.switchCard, ...cardSurfaceStyle }}>
                    <View style={styles.switchText}>
                      <Text size={16}>{t('timeout_exit_label_isPlayed')}</Text>
                      <Text style={styles.optionDesc} size={13} color={theme['c-font-label']}>{t('timeout_exit_label_isPlayed_desc')}</Text>
                    </View>
                    <Switch
                      value={timeoutExitPlayed}
                      onValueChange={handleToggleFinishCurrent}
                      trackColor={{ false: '#E7EAF0', true: theme['c-primary'] }}
                      thumbColor="#FFFFFF"
                      ios_backgroundColor="#E7EAF0"
                    />
                  </View>
                </ScrollView>
              </SafeAreaView>

              <CustomTimePicker
                visible={customPickerVisible}
                hours={pickerHours}
                minutes={pickerMinutes}
                onClose={() => { setCustomPickerVisible(false) }}
                onConfirm={handleApplyCustom}
                onChangeHours={setPickerHours}
                onChangeMinutes={setPickerMinutes}
              />
            </View>
          </Modal>
        )
      : null
  )
})

const styles = createStyle({
  mask: {
    flex: 1,
  },
  sheet: {
    flex: 1,
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
    fontWeight: '600',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingBottom: 42,
  },
  sectionTitle: {
    marginTop: 14,
    marginBottom: 12,
    paddingLeft: 4,
  },
  card: {
    borderRadius: 22,
    overflow: 'hidden',
  },
  statusCard: {
    minHeight: 140,
    borderRadius: 22,
    paddingHorizontal: 22,
    paddingVertical: 22,
    justifyContent: 'center',
  },
  countdownText: {
    fontSize: 34,
    lineHeight: 40,
    marginBottom: 10,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  statusTitle: {
    marginBottom: 8,
    fontWeight: '600',
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
  optionTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  optionValue: {
    marginRight: 12,
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
  pickerMask: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    zIndex: 20,
    elevation: 20,
  },
  pickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(35, 35, 35, .24)',
  },
  pickerPanel: {
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    paddingTop: 18,
    paddingBottom: 28,
    paddingHorizontal: 18,
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  pickerTitle: {
    fontWeight: '600',
  },
  pickerConfirmBtn: {
    minWidth: 80,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  pickerBody: {
    height: WHEEL_HEIGHT + 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    paddingHorizontal: 10,
  },
  wheelOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 8 + WHEEL_ITEM_HEIGHT * 2,
    height: WHEEL_ITEM_HEIGHT,
    alignItems: 'center',
  },
  wheelOverlayHighlight: {
    width: '82%',
    height: WHEEL_ITEM_HEIGHT,
    borderRadius: 16,
  },
  wheelColumnWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  wheelList: {
    width: 84,
    height: WHEEL_HEIGHT,
  },
  wheelContent: {
    paddingVertical: WHEEL_ITEM_HEIGHT * 2,
  },
  wheelItem: {
    height: WHEEL_ITEM_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wheelLabel: {
    width: 54,
    textAlign: 'center',
  },
})
