/**
 * Opus codec + format helpers. Prefers @discordjs/opus (native libopus) and
 * falls back to opusscript (wasm) so the bridge runs even where the native
 * build failed. Both are wrapped behind the same tiny interface.
 *
 * House format: 48 kHz stereo. Decoders use channels=2: libopus upmixes mono
 * streams to stereo, so one decoder handles mono browser mics and stereo
 * peers alike.
 */
import { FRAME_FLOATS, FRAME_SAMPLES } from './engine.js';

export type RawCodec = {
  encode(pcm16: Buffer): Buffer;
  decode(opus: Buffer): Buffer | null;
  setBitrate?(b: number): void;
  close?(): void;
};

export let codecBackend = 'none';

async function loadNative(): Promise<(() => RawCodec) | null> {
  try {
    const m = (await import('@discordjs/opus')) as unknown as {
      default?: { OpusEncoder: new (rate: number, ch: number) => {
        encode(pcm: Buffer, frameSize?: number): Buffer;
        decode(opus: Buffer): Buffer;
        setBitrate(b: number): void;
      } };
      OpusEncoder?: new (rate: number, ch: number) => {
        encode(pcm: Buffer, frameSize?: number): Buffer;
        decode(opus: Buffer): Buffer;
        setBitrate(b: number): void;
      };
    };
    const OpusEncoder = m.OpusEncoder ?? m.default?.OpusEncoder;
    if (!OpusEncoder) return null;
    codecBackend = '@discordjs/opus';
    return () => {
      const enc = new OpusEncoder(48000, 2);
      try {
        enc.setBitrate(64000);
      } catch {
        /* ignore */
      }
      return {
        encode: (pcm: Buffer) => enc.encode(pcm, FRAME_SAMPLES),
        decode: (opus: Buffer) => {
          try {
            return enc.decode(opus);
          } catch {
            return null; // corrupt packet; opus PLC handles the gap
          }
        },
        setBitrate: (b: number) => enc.setBitrate(b),
      };
    };
  } catch {
    return null;
  }
}

async function loadWasm(): Promise<(() => RawCodec) | null> {
  try {
    const m = await import('opusscript');
    const OpusScript = (m.default ?? m) as unknown as new (r: number, c: number, app: number) => {
      encode(pcm: Buffer, frameSize: number): Buffer;
      decode(opus: Buffer): Buffer;
      setBitrate?(b: number): void;
    };
    codecBackend = 'opusscript';
    return () => {
      // opusscript instances both encode and decode. CRITICAL: its embedded
      // (ancient) libopus calls abort() on some real-world packets (seen with
      // Haven 4.26.x clients). In WASM abort() throws a RuntimeError that IS
      // catchable, but the instance is dead forever after — it must be RECREATED
      // or every later packet fails too (symptom: bot connected, nobody hears
      // anyone, journal full of "Aborted()"). Hence self-heal: recreate on abort.
      let inst = new OpusScript(48000, 2, 2048 /* VOIP */);
      let failStreak = 0;
      let failLogged = 0;
      return {
        encode: (pcm: Buffer) => inst.encode(pcm, FRAME_SAMPLES),
        decode: (opus: Buffer) => {
          if (opus.length < 2) return null;
          try {
            const out = inst.decode(opus);
            failStreak = 0;
            return out;
          } catch (e) {
            // keep forensic evidence of the killer packet (throttled)
            if (++failLogged <= 5 || failLogged % 500 === 0) {
              console.error(
                `[codec] opusscript decode fail #${failLogged} len=${opus.length} ` +
                  `head=${opus.subarray(0, 4).toString('hex')} ` +
                  `err=${e instanceof Error ? e.message.slice(0, 60) : String(e).slice(0, 60)}`,
              );
            }
            if (++failStreak >= 2) {
              failStreak = 0;
              try {
                inst = new OpusScript(48000, 2, 2048);
              } catch {
                /* nothing else we can do */
              }
            }
            return null; // opus PLC handles the gap
          }
        },
        setBitrate: (b: number) => inst.setBitrate?.(b),
      };
    };
  } catch {
    return null;
  }
}

const rawMakeCodec = (await loadNative()) ?? (await loadWasm());
if (!rawMakeCodec) {
  throw new Error('No Opus codec available: install @discordjs/opus or opusscript');
}
const makeCodec: () => RawCodec = rawMakeCodec;

export type Decoder = { decode(opus: Buffer): Int16Array | null };
export type Encoder = { encode(pcm16: Buffer): Buffer; setBitrate?(b: number): void };

/** 48 kHz stereo Opus decoder (mono sources upmix to stereo). */
export function makeDecoder(): Decoder {
  const c = makeCodec();
  return {
    decode(opus: Buffer): Int16Array | null {
      const pcm = c.decode(opus);
      if (!pcm || pcm.byteLength === 0) return null;
      return new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    },
  };
}

/** 48 kHz stereo Opus encoder (VOIP profile). */
export function makeEncoder(bitrate = 64_000): Encoder {
  const c = makeCodec();
  c.setBitrate?.(bitrate);
  return {
    encode: (pcm16: Buffer) => c.encode(pcm16),
    setBitrate: (b: number) => c.setBitrate?.(b),
  };
}

/** interleaved float32 [-1,1] -> s16le Buffer (FRAME_FLOATS samples) */
export function floatToS16(frame: Float32Array): Buffer {
  const out = Buffer.alloc(FRAME_FLOATS * 2);
  for (let i = 0; i < FRAME_FLOATS; i++) {
    let v = frame[i] * 32767;
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out.writeInt16LE(v | 0, i * 2);
  }
  return out;
}

/** s16le (already 48k stereo, any length) -> new interleaved float32 */
export function pcm16ToFloatStereo(pcm: Int16Array): Float32Array {
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
  return f;
}

/** s16le mono (count samples) -> interleaved stereo float32 (dup upmix) */
export function s16MonoToFloatStereo(pcm: Int16Array, out: Float32Array): void {
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768;
    out[i * 2] = v;
    out[i * 2 + 1] = v;
  }
}
