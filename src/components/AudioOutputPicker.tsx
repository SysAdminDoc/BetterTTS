import { Volume2 } from 'lucide-react'
import { useState } from 'react'
import { selectAudioOutputDevice } from '../lib/audio-output.ts'
import { playbackController } from '../lib/playback-controller.ts'

export function AudioOutputPicker() {
  const [busy, setBusy] = useState(false)
  const [label, setLabel] = useState('Output device')
  const [error, setError] = useState<string | null>(null)

  const chooseOutput = async () => {
    setBusy(true)
    setError(null)
    try {
      const device = await selectAudioOutputDevice()
      await playbackController.setSinkId(device.deviceId)
      setLabel(device.label)
    } catch (nextError: unknown) {
      setError(nextError instanceof DOMException && nextError.name === 'AbortError'
        ? 'Output selection cancelled.'
        : nextError instanceof Error ? nextError.message : 'The output device could not be changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="audio-output-picker"
        onClick={() => void chooseOutput()}
        disabled={busy}
        aria-label="Choose audio output device"
        title="Choose the speaker or headset used for BetterTTS playback"
        data-testid="audio-output-picker"
      >
        <Volume2 size={14} aria-hidden="true" />
        {busy ? 'Choosing…' : label}
      </button>
      {error ? <span className="audio-output-error" role="status">{error}</span> : null}
    </>
  )
}
