declare module 'signalsmith-stretch' {
  export type SignalsmithSchedule = {
    active?: boolean
    input?: number
    output?: number
    outputTime?: number
    rate?: number
    semitones?: number
    tonalityHz?: number
    formantSemitones?: number
    formantCompensation?: boolean
    formantBaseHz?: number
    loopStart?: number
    loopEnd?: number
  }

  export type SignalsmithConfig = {
    blockMs?: number | null
    intervalMs?: number
    splitComputation?: boolean
    preset?: 'default' | 'cheaper'
  }

  export type SignalsmithStretchNode = AudioNode & {
    inputTime: number
    addBuffers(buffers: Float32Array[]): Promise<number>
    configure(config: SignalsmithConfig): Promise<void>
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>
    latency(): Promise<number>
    schedule(change: SignalsmithSchedule, adjustPrevious?: boolean): Promise<SignalsmithSchedule>
    start(when?: number | SignalsmithSchedule, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<SignalsmithSchedule>
    stop(when?: number): Promise<SignalsmithSchedule>
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<void>
  }

  export default function SignalsmithStretch(audioContext: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<SignalsmithStretchNode>
}
