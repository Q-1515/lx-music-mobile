import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Animated, Pressable, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'

import { type COMPONENT_IDS } from '@/config/constant'

interface Props {
  visibleNavNames: COMPONENT_IDS[]
  widthPercentage: number
  widthPercentageMax?: number
  children: React.ReactNode
  renderNavigationView: () => React.ReactNode
  drawerPosition?: 'left' | 'right'
  drawerBackgroundColor?: string
  style?: StyleProp<ViewStyle>
}

export interface DrawerLayoutFixedType {
  openDrawer: () => void
  closeDrawer: () => void
  fixWidth: () => void
}

const DrawerLayoutFixed = forwardRef<DrawerLayoutFixedType, Props>(({
  widthPercentage,
  widthPercentageMax,
  children,
  renderNavigationView,
  drawerPosition = 'left',
  drawerBackgroundColor,
  style,
}, ref) => {
  const [containerWidth, setContainerWidth] = useState(0)
  const [visible, setVisible] = useState(false)
  const animation = useRef(new Animated.Value(0)).current

  const drawerWidth = useMemo(() => {
    if (!containerWidth) return 0
    const width = Math.floor(containerWidth * widthPercentage)
    return widthPercentageMax ? Math.min(width, widthPercentageMax) : width
  }, [containerWidth, widthPercentage, widthPercentageMax])

  const openDrawer = useCallback(() => {
    if (!drawerWidth) return
    setVisible(true)
    global.app_event.changeHomePageScrollEnabled(false)
    Animated.timing(animation, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start()
  }, [animation, drawerWidth])

  const closeDrawer = useCallback(() => {
    Animated.timing(animation, {
      toValue: 0,
      duration: 180,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setVisible(false)
      global.app_event.changeHomePageScrollEnabled(true)
    })
  }, [animation])

  useImperativeHandle(ref, () => ({
    openDrawer,
    closeDrawer,
    fixWidth() {},
  }), [closeDrawer, openDrawer])

  const handleLayout = useCallback(({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    setContainerWidth(layout.width)
  }, [])

  const drawerTranslate = animation.interpolate({
    inputRange: [0, 1],
    outputRange: drawerPosition == 'left' ? [-drawerWidth, 0] : [drawerWidth, 0],
  })
  const overlayOpacity = animation.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.32],
  })

  return (
    <View onLayout={handleLayout} style={[{ flex: 1, width: '100%' }, style]}>
      <View style={{ flex: 1 }}>
        {children}
      </View>
      {
        drawerWidth
          ? (
              <View
                pointerEvents={visible ? 'auto' : 'box-none'}
                style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
              >
                <Animated.View
                  pointerEvents={visible ? 'auto' : 'none'}
                  style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, opacity: overlayOpacity }}
                >
                  <Pressable onPress={closeDrawer} style={{ flex: 1, backgroundColor: '#000' }} />
                </Animated.View>
                <Animated.View
                  pointerEvents={visible ? 'auto' : 'none'}
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    width: drawerWidth,
                    backgroundColor: drawerBackgroundColor,
                    transform: [{ translateX: drawerTranslate }],
                    left: drawerPosition == 'left' ? 0 : undefined,
                    right: drawerPosition == 'right' ? 0 : undefined,
                  }}
                >
                  {renderNavigationView()}
                </Animated.View>
              </View>
            )
          : null
      }
    </View>
  )
})

export default DrawerLayoutFixed
