import { useState } from 'react'
import type { ClipRecord } from '../lib/library.ts'

export function useLibrary() {
  const [library, setLibrary] = useState<ClipRecord[]>([])
  return { library, setLibrary }
}
