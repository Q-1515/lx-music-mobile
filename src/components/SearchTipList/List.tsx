import { useState, useRef, useImperativeHandle, forwardRef, type Ref } from 'react'
import { FlatList, type FlatListProps } from 'react-native'

// import InsetShadow from 'react-native-inset-shadow'

export type ItemT<T> = FlatListProps<T>['data']

export type ListProps<T> = Pick<FlatListProps<T>,
| 'renderItem'
| 'maxToRenderPerBatch'
| 'windowSize'
| 'initialNumToRender'
| 'keyExtractor'
| 'getItemLayout'
| 'keyboardShouldPersistTaps'
>

export interface ListType<T> {
  setList: (list: T[]) => void
}

const List = <T extends ItemT<T>>(props: ListProps<T>, ref: Ref<ListType<T>>) => {
  const [list, setList] = useState<T[]>([])
  const flatListRef = useRef<FlatList<T>>(null)
  useImperativeHandle(ref, () => ({
    setList(list) {
      setList(list)
      requestAnimationFrame(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: false })
      })
    },
  }))

  return <FlatList ref={flatListRef} removeClippedSubviews={true} keyboardShouldPersistTaps={'always'} {...props} data={list} />
}

export default forwardRef(List) as
  <M,>(p: ListProps<M> & { ref?: Ref<ListType<M>> }) => JSX.Element | null


