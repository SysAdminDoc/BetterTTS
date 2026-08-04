import modelAssets from './model-assets.json'

export type KokoroAssetIntegrity = {
  size: number
  sha256: string
}

export async function kokoroAssetIntegrity(relativePath: string): Promise<KokoroAssetIntegrity | null> {
  const asset = [...modelAssets.kokoro.remoteAssets, ...modelAssets.kokoro.voiceAssets]
    .find((candidate) => candidate.path === relativePath)
  return asset ? { size: asset.size, sha256: asset.sha256 } : null
}

export function piper(): string {
  const { modelId, revision, onnx } = modelAssets.piper
  return `https://huggingface.co/${modelId}/resolve/${revision}/${onnx.path}`
}

export async function verifyKokoroAssetBytes(
  relativePath: string,
  bytes: Uint8Array,
  expected: KokoroAssetIntegrity,
): Promise<void> {
  if (bytes.byteLength !== expected.size) {
    throw new Error(`Kokoro asset size mismatch for ${relativePath}: expected ${expected.size}, got ${bytes.byteLength}`)
  }

  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Kokoro asset verification requires crypto.subtle.')
  const digestBytes = new Uint8Array(bytes.byteLength)
  digestBytes.set(bytes)
  const digest = await subtle.digest('SHA-256', digestBytes.buffer as ArrayBuffer)
  const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
  if (actual !== expected.sha256) {
    throw new Error(`Kokoro asset checksum mismatch for ${relativePath}: expected ${expected.sha256}, got ${actual}`)
  }
}

export async function verifyKokoro(relativePath: string, response: Response): Promise<Response> {
  const expected = response.ok ? await kokoroAssetIntegrity(relativePath) : null
  if (!expected) return response
  await verifyKokoroAssetBytes(relativePath, new Uint8Array(await response.clone().arrayBuffer()), expected)
  return response
}
