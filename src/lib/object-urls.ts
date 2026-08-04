import { useEffect, useRef } from 'react'

export type ObjectUrlRegistry = {
  addOutput: (url: string) => string
  addCaption: (url: string) => string
  clearOutputs: () => void
  clearCaptions: () => void
  dispose: () => void
}

export function createObjectUrlRegistry(revokeUrl: (url: string) => void = (url) => URL.revokeObjectURL(url)): ObjectUrlRegistry {
  const outputUrls = new Set<string>()
  const captionUrls = new Set<string>()
  const revokeSet = (urls: Set<string>) => {
    for (const url of urls) revokeUrl(url)
    urls.clear()
  }
  return {
    addOutput: (url) => {
      outputUrls.add(url)
      return url
    },
    addCaption: (url) => {
      captionUrls.add(url)
      return url
    },
    clearOutputs: () => revokeSet(outputUrls),
    clearCaptions: () => revokeSet(captionUrls),
    dispose: () => {
      revokeSet(outputUrls)
      revokeSet(captionUrls)
    },
  }
}

export function useObjectUrls(): {
  rememberUrl: (url: string) => string
  rememberCaptionUrl: (url: string) => string
  clearOutputUrls: () => void
  clearCaptionUrls: () => void
} {
  const registryRef = useRef<ObjectUrlRegistry | null>(null)
  if (!registryRef.current) registryRef.current = createObjectUrlRegistry()
  useEffect(() => () => registryRef.current?.dispose(), [])
  return {
    rememberUrl: registryRef.current.addOutput,
    rememberCaptionUrl: registryRef.current.addCaption,
    clearOutputUrls: registryRef.current.clearOutputs,
    clearCaptionUrls: registryRef.current.clearCaptions,
  }
}
