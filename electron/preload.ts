import { contextBridge, ipcRenderer } from 'electron'

const NATIVE_TTS_CHANNEL = 'bettertts:native-tts'
const UPDATE_STATUS_CHANNEL = 'bettertts:update-status'
const UPDATE_ACTION_CHANNEL = 'bettertts:update-action'
const PROJECT_CHANNEL = 'bettertts:project'
const FFMPEG_CHANNEL = 'bettertts:ffmpeg'
const WHISPER_CHANNEL = 'bettertts:whisper'
const SIDECAR_CHANNEL = 'bettertts:sidecar'
const BYO_WEIGHTS_CHANNEL = 'bettertts:byo-weights'
const RVC_CHANNEL = 'bettertts:rvc'
const RVC_WEIGHTS_CHANNEL = 'bettertts:rvc-weights'
const OPENAI_TTS_CHANNEL = 'bettertts:openai-tts'
const DESKTOP_INTEGRATIONS_STATUS_CHANNEL = 'bettertts:desktop-integrations-status'
const DESKTOP_INTEGRATIONS_TEXT_CHANNEL = 'bettertts:desktop-integrations-text'
const DESKTOP_INTEGRATIONS_FILES_CHANNEL = 'bettertts:desktop-integrations-files'
const DESKTOP_INTEGRATIONS_ERROR_CHANNEL = 'bettertts:desktop-integrations-error'
const DESKTOP_INTEGRATIONS_CHANNEL = 'bettertts:desktop-integrations'
const DESKTOP_INTEGRATIONS_OCR_CHANNEL = 'bettertts:desktop-integrations-ocr'
const DESKTOP_INTEGRATIONS_RENDER_CHANNEL = 'bettertts:desktop-integrations-render'
const DESKTOP_DIAGNOSTICS_CHANNEL = 'bettertts:desktop-diagnostics'
const DESKTOP_DIAGNOSTICS_LOG_CHANNEL = 'bettertts:desktop-diagnostics-log'

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
  byoWeights: {
    choose(modelId: string): Promise<unknown> {
      return ipcRenderer.invoke(BYO_WEIGHTS_CHANNEL, { modelId })
    },
  },
  rvc: {
    post(message: unknown): void {
      ipcRenderer.send(RVC_CHANNEL, message)
    },
    onMessage(listener: (message: unknown) => void): () => void {
      const handler = (_event: unknown, message: unknown) => listener(message)
      ipcRenderer.on(RVC_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(RVC_CHANNEL, handler)
      }
    },
  },
  rvcWeights: {
    chooseModel(): Promise<unknown> {
      return ipcRenderer.invoke(RVC_WEIGHTS_CHANNEL, { action: 'model' })
    },
    chooseIndex(): Promise<unknown> {
      return ipcRenderer.invoke(RVC_WEIGHTS_CHANNEL, { action: 'index' })
    },
  },
  openAiServer: {
    status(): Promise<unknown> {
      return ipcRenderer.invoke(OPENAI_TTS_CHANNEL, { action: 'status' })
    },
    start(port: number): Promise<unknown> {
      return ipcRenderer.invoke(OPENAI_TTS_CHANNEL, { action: 'start', port })
    },
    stop(): Promise<unknown> {
      return ipcRenderer.invoke(OPENAI_TTS_CHANNEL, { action: 'stop' })
    },
  },
  desktopIntegrations: {
    status(): Promise<unknown> {
      return ipcRenderer.invoke(DESKTOP_INTEGRATIONS_CHANNEL, { action: 'status' })
    },
    setEnabled(kind: 'hotkey' | 'explorer' | 'ocr' | 'tray' | 'notifications', enabled: boolean): Promise<unknown> {
      return ipcRenderer.invoke(DESKTOP_INTEGRATIONS_CHANNEL, { action: 'set-enabled', kind, enabled })
    },
    chooseFolder(): Promise<unknown> {
      return ipcRenderer.invoke(DESKTOP_INTEGRATIONS_CHANNEL, { action: 'folder' })
    },
    setRenderStatus(status: unknown): void {
      ipcRenderer.send(DESKTOP_INTEGRATIONS_RENDER_CHANNEL, status)
    },
    ocr(): Promise<unknown> {
      return ipcRenderer.invoke(DESKTOP_INTEGRATIONS_OCR_CHANNEL)
    },
    onStatus(listener: (status: unknown) => void): () => void {
      const handler = (_event: unknown, status: unknown) => listener(status)
      ipcRenderer.on(DESKTOP_INTEGRATIONS_STATUS_CHANNEL, handler)
      return () => ipcRenderer.removeListener(DESKTOP_INTEGRATIONS_STATUS_CHANNEL, handler)
    },
    onText(listener: (message: unknown) => void): () => void {
      const handler = (_event: unknown, message: unknown) => listener(message)
      ipcRenderer.on(DESKTOP_INTEGRATIONS_TEXT_CHANNEL, handler)
      return () => ipcRenderer.removeListener(DESKTOP_INTEGRATIONS_TEXT_CHANNEL, handler)
    },
    onFiles(listener: (files: unknown) => void): () => void {
      const handler = (_event: unknown, files: unknown) => listener(files)
      ipcRenderer.on(DESKTOP_INTEGRATIONS_FILES_CHANNEL, handler)
      return () => ipcRenderer.removeListener(DESKTOP_INTEGRATIONS_FILES_CHANNEL, handler)
    },
    onError(listener: (error: unknown) => void): () => void {
      const handler = (_event: unknown, error: unknown) => listener(error)
      ipcRenderer.on(DESKTOP_INTEGRATIONS_ERROR_CHANNEL, handler)
      return () => ipcRenderer.removeListener(DESKTOP_INTEGRATIONS_ERROR_CHANNEL, handler)
    },
  },
  desktopDiagnostics: {
    collect(input: unknown): Promise<unknown> {
      const payload = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
      return ipcRenderer.invoke(DESKTOP_DIAGNOSTICS_CHANNEL, { action: 'collect', ...payload })
    },
    log(level: 'info' | 'warn' | 'error', source: string, message: unknown): void {
      ipcRenderer.send(DESKTOP_DIAGNOSTICS_LOG_CHANNEL, { level, source, message })
    },
  },
}

contextBridge.exposeInMainWorld('betterttsPlatform', bridge)

export type BetterttsPlatformBridge = typeof bridge
