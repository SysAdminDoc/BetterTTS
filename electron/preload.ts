import { contextBridge, ipcRenderer } from 'electron'

const NATIVE_TTS_CHANNEL = 'bettertts:native-tts'
const UPDATE_STATUS_CHANNEL = 'bettertts:update-status'
const UPDATE_ACTION_CHANNEL = 'bettertts:update-action'
const PROJECT_CHANNEL = 'bettertts:project'
const FFMPEG_CHANNEL = 'bettertts:ffmpeg'
const WHISPER_CHANNEL = 'bettertts:whisper'
const SIDECAR_CHANNEL = 'bettertts:sidecar'

// The single, narrow bridge the renderer sees. Native TTS messages relay
// through main to the inference utilityProcess; payloads are structured-clone
// data only (strings, numbers, Float32Array) — no functions, no handles.
const bridge = {
  isDesktop: true as const,
  kind: 'desktop' as const,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  nativeTts: {
    post(message: unknown): void {
      ipcRenderer.send(NATIVE_TTS_CHANNEL, message)
    },
    onMessage(listener: (message: unknown) => void): () => void {
      const handler = (_event: unknown, message: unknown) => listener(message)
      ipcRenderer.on(NATIVE_TTS_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(NATIVE_TTS_CHANNEL, handler)
      }
    },
  },
  updater: {
    check(): void {
      ipcRenderer.send(UPDATE_ACTION_CHANNEL, 'check')
    },
    download(): void {
      ipcRenderer.send(UPDATE_ACTION_CHANNEL, 'download')
    },
    install(): void {
      ipcRenderer.send(UPDATE_ACTION_CHANNEL, 'install')
    },
    onStatus(listener: (status: unknown) => void): () => void {
      const handler = (_event: unknown, status: unknown) => listener(status)
      ipcRenderer.on(UPDATE_STATUS_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, handler)
      }
    },
  },
  projects: {
    save(bytes: Uint8Array, suggestedName: string, saveAs = false): Promise<unknown> {
      return ipcRenderer.invoke(PROJECT_CHANNEL, { action: 'save', bytes, suggestedName, saveAs })
    },
    open(): Promise<unknown> {
      return ipcRenderer.invoke(PROJECT_CHANNEL, { action: 'open' })
    },
    forget(): Promise<unknown> {
      return ipcRenderer.invoke(PROJECT_CHANNEL, { action: 'forget' })
    },
  },
  ffmpeg: {
    status(): Promise<unknown> {
      return ipcRenderer.invoke(FFMPEG_CHANNEL, { action: 'status' })
    },
    transcode(request: unknown): Promise<unknown> {
      return ipcRenderer.invoke(FFMPEG_CHANNEL, { action: 'transcode', ...(request as object) })
    },
    audiobook(request: unknown): Promise<unknown> {
      return ipcRenderer.invoke(FFMPEG_CHANNEL, { action: 'audiobook', ...(request as object) })
    },
  },
  whisper: {
    post(message: unknown): void {
      ipcRenderer.send(WHISPER_CHANNEL, message)
    },
    onMessage(listener: (message: unknown) => void): () => void {
      const handler = (_event: unknown, message: unknown) => listener(message)
      ipcRenderer.on(WHISPER_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(WHISPER_CHANNEL, handler)
      }
    },
  },
  sidecar: {
    post(message: unknown): void {
      ipcRenderer.send(SIDECAR_CHANNEL, message)
    },
    onMessage(listener: (message: unknown) => void): () => void {
      const handler = (_event: unknown, message: unknown) => listener(message)
      ipcRenderer.on(SIDECAR_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(SIDECAR_CHANNEL, handler)
      }
    },
  },
}

contextBridge.exposeInMainWorld('betterttsPlatform', bridge)

export type BetterttsPlatformBridge = typeof bridge
