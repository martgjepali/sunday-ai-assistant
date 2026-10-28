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

  export class GenerationConfig {
    constructor(opts: { sid?: number; speed?: number; silenceScale?: number });
  }
  export interface OfflineTtsConfig {
    model: {
      kokoro?: { model: string; voices: string; tokens: string; lexicon?: string; lengthScale?: number };
      numThreads?: number;
      provider?: string;
      debug?: boolean;
    };
    maxNumSentences?: number;
  }
  export class OfflineTts {
    static createAsync(config: OfflineTtsConfig): Promise<OfflineTts>;
    readonly numSpeakers: number;
    readonly sampleRate: number;
    generateAsync(req: {
      text: string;
      enableExternalBuffer?: boolean;
      generationConfig?: GenerationConfig;
    }): Promise<{ samples: Float32Array; sampleRate: number }>;
  }
}
