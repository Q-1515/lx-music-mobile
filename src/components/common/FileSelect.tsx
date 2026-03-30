import ChoosePath, { type ReadOptions, type ChoosePathType } from '@/components/common/ChoosePath'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

export interface FileSelectType {
  show: (options: ReadOptions, onSelect: typeof noop) => void
}
const noop = (path: string) => {}
export default forwardRef<FileSelectType, {}>((props, ref) => {
  const [visible, setVisible] = useState(false)
  const choosePathRef = useRef<ChoosePathType>(null)
  const onSelectRef = useRef<typeof noop>(noop)
  const pendingOptionsRef = useRef<ReadOptions | null>(null)
  // console.log('render import export')

  useEffect(() => {
    if (!visible || !pendingOptionsRef.current || !choosePathRef.current) return
    const options = pendingOptionsRef.current
    pendingOptionsRef.current = null
    choosePathRef.current.show(options)
  }, [visible])

  useImperativeHandle(ref, () => ({
    show(options, onSelect) {
      onSelectRef.current = onSelect ?? noop
      if (visible) {
        choosePathRef.current?.show(options)
      } else {
        pendingOptionsRef.current = options
        setVisible(true)
      }
    },
  }))

  return (
    visible
      ? <ChoosePath ref={choosePathRef} onConfirm={onSelectRef.current} />
      : null
  )
})
