export type WritableFileLike = {
  write(data: Blob): Promise<void>
  close(): Promise<void>
  abort(reason?: unknown): Promise<void>
}

export class FileSaveError extends Error {
  readonly destinationChanged: false | 'unknown'

  constructor(
    message: string,
    destinationChanged: false | 'unknown',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'FileSaveError'
    this.destinationChanged = destinationChanged
  }
}

export async function commitBlobToFile(
  createWritable: () => Promise<WritableFileLike>,
  blob: Blob,
): Promise<void> {
  let writable: WritableFileLike | null = null
  try {
    writable = await createWritable()
    await writable.write(blob)
    await writable.close()
    writable = null
  } catch (error) {
    let destinationChanged: false | 'unknown' = false
    if (writable) {
      try {
        await writable.abort(error)
      } catch {
        destinationChanged = 'unknown'
      }
    }
    const state = destinationChanged === false
      ? 'The destination was not changed.'
      : 'The destination may contain a partial file; inspect or remove it before retrying.'
    throw new FileSaveError(`Could not commit the file. ${state}`, destinationChanged, { cause: error })
  }
}
