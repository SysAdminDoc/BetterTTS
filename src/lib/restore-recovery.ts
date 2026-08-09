let recoveryPromise: Promise<void> | undefined

export function loadPortableBackup() {
  return import('./backup.ts')
}

export function ensurePortableBackupRecovery(): Promise<void> {
  return recoveryPromise ??= loadPortableBackup()
    .then((module) => module.recoverPortableBackupRestore())
}
