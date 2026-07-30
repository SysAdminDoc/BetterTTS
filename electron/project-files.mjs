import { createHash } from 'node:crypto'
import { open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

export const MAX_PROJECT_BYTES = 512 * 1024 * 1024

export class ProjectConflictError extends Error {
  constructor(currentIdentity) {
    super('The project changed on disk after it was opened or last saved.')
    this.name = 'ProjectConflictError'
    this.currentIdentity = currentIdentity
  }
}

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

function identityFor(bytes, info) {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const mtimeMs = info.mtimeMs
  return {
    revision: `${Math.trunc(mtimeMs * 1000).toString(36)}-${sha256.slice(0, 16)}`,
    sha256,
    mtimeMs,
    size: info.size,
  }
}

export function projectIdentitiesMatch(left, right) {
  return Boolean(
    left
    && right
    && left.revision === right.revision
    && left.sha256 === right.sha256
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size,
  )
}

export async function readProjectSnapshot(path) {
  if (extname(path).toLowerCase() !== '.bettertts') throw new Error('Choose a .bettertts project.')
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await stat(path)
    if (!before.isFile() || before.size === 0 || before.size > MAX_PROJECT_BYTES) {
      throw new Error('Project must be a file between 1 byte and 512 MB.')
    }
    const bytes = validateProjectBytes(await readFile(path))
    const after = await stat(path)
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { bytes, identity: identityFor(bytes, after) }
    }
  }
  throw new Error('Project changed while it was being read. Try opening it again.')
}

export async function inspectProjectIdentity(path) {
  try {
    return (await readProjectSnapshot(path)).identity
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

export async function writeProjectFile(path, value, options = {}) {
  const target = normalizeProjectPath(path)
  const bytes = validateProjectBytes(value)
  const expectedIdentity = options.expectedIdentity ?? null
  if (expectedIdentity && !projectIdentitiesMatch(expectedIdentity, await inspectProjectIdentity(target))) {
    throw new ProjectConflictError(await inspectProjectIdentity(target))
  }

  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`)
  try {
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await options.beforeCommit?.()
    if (expectedIdentity && !projectIdentitiesMatch(expectedIdentity, await inspectProjectIdentity(target))) {
      throw new ProjectConflictError(await inspectProjectIdentity(target))
    }
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return { path: target, identity: await inspectProjectIdentity(target) }
}

export async function readProjectFile(path) {
  return (await readProjectSnapshot(path)).bytes
}
