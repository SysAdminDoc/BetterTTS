export type ProjectIdentity = {
  revision: string
  sha256: string
  mtimeMs: number
  size: number
}

export class ProjectConflictError extends Error {
  currentIdentity: ProjectIdentity | null
}

export function readProjectSnapshot(path: string): Promise<{
  bytes: Uint8Array
  identity: ProjectIdentity
}>

export function writeProjectFile(
  path: string,
  bytes: Uint8Array,
  options?: { expectedIdentity?: ProjectIdentity | null },
): Promise<{ path: string; identity: ProjectIdentity }>
