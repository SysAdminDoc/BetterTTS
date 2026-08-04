import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'

export function assertAssetMetadata(asset) {
  if (!asset || typeof asset.path !== 'string' || asset.path.length === 0 || asset.path.includes('..')) {
    throw new Error(`Invalid model asset path: ${asset?.path ?? '<missing>'}`)
  }
  if (!Number.isSafeInteger(asset.size) || asset.size < 0) {
    throw new Error(`Invalid model asset size for ${asset.path}.`)
  }
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) {
    throw new Error(`Invalid SHA-256 for ${asset.path}.`)
  }
}

export async function hashFile(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyFile(filePath, asset, label = asset.path) {
  assertAssetMetadata(asset)
  const size = statSync(filePath).size
  if (size !== asset.size) {
    throw new Error(`${label} has unexpected size: expected ${asset.size}, got ${size}`)
  }
  const sha256 = await hashFile(filePath)
  if (sha256 !== asset.sha256.toLowerCase()) {
    throw new Error(`${label} has unexpected SHA-256: expected ${asset.sha256}, got ${sha256}`)
  }
}
