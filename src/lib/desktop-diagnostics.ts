export type DesktopLogEntry = {
  time: string
  level: 'info' | 'warn' | 'error'
  source: string
  message: string
}

export type DesktopDiagnosticsSnapshot = {
  schemaVersion: 1
  app: {
    version: string
    platform: string
    arch: string
    osRelease: string
    electron: string
    chrome: string
    node: string
    packaged: boolean
  }
  selection: {
    engine: string
    provider: string
    engineStatus: string
    runtime: string
    selectedModel: string
    modelManifest: Record<string, unknown>
    modelRoutes: Record<string, string>
  }
  generation: {
    engine: string
    runtime: string
    elapsedMs: number
    timeToFirstAudioMs: number | null
    audioDurationSeconds: number
    chars: number
  } | null
  runtimes: {
    native: Record<string, unknown>
    qwen: Record<string, unknown>
    whisper: Record<string, unknown>
    rvc: Record<string, unknown>
  }
  ffmpeg: Record<string, unknown>
  paths: {
    userData: string
    project: string
    modelCache: string
    resources: string
  }
  recentLogs: DesktopLogEntry[]
}
