import { open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

export const MAX_PROJECT_BYTES = 512 * 1024 * 1024

export function normalizeProjectPath(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Project path is missing.')
  return extname(path).toLowerCase() === '.bettertts' ? path : `${path}.bettertts`
}

export function validateProjectBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PROJECT_BYTES) {
    throw new Error('Project must be between 1 byte and 512 MB.')
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('Project is not a valid BetterTTS archive.')
  }
  return bytes
}

export async function writeProjectFile(path, value) {
  const target = normalizeProjectPath(path)
  const bytes = validateProjectBytes(value)
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`)
  try {
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return target
}

export async function readProjectFile(path) {
  if (extname(path).toLowerCase() !== '.bettertts') throw new Error('Choose a .bettertts project.')
  const info = await stat(path)
  if (!info.isFile() || info.size === 0 || info.size > MAX_PROJECT_BYTES) {
    throw new Error('Project must be a file between 1 byte and 512 MB.')
  }
  return validateProjectBytes(await readFile(path))
}
