import { dirname, join, resolve } from 'node:path'

export function resolveSmokeOutputDirectory(options: {
  appPath: string
  tempPath: string
  packaged: boolean
  reportPath?: string
}): string {
  if (options.reportPath) return dirname(resolve(options.reportPath))
  return options.packaged
    ? join(options.tempPath, 'bettertts-smoke')
    : join(options.appPath, 'dist-electron')
}
