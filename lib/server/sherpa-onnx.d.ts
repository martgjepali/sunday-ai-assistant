// Minimal types for the parts of sherpa-onnx-node SUNDAY uses (the package ships JSDoc only).
declare module "sherpa-onnx-node" {
  export interface OnlineStream {
    acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
    inputFinished(): void;
  }
  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads?: number; debug?: boolean; provider?: string });
    readonly dim: number;
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array;
  }
}
