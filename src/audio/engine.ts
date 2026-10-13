/**
 * Core audio engine: one shared 48 kHz stereo clock at 20 ms/frame, with
 * jitter-ringed input streams per source user and per-OUTLET mix-minus
 * fan-out. Outlets are finer than platforms: the Haven leg is a P2P mesh,
 * so each Haven peer gets its own outlet that excludes THAT user.
 */

export const SAMPLE_RATE = 48_000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 960
export const FRAME_FLOATS = FRAME_SAMPLES * 2; // interleaved stereo

export type Platform = 'discord' | 'haven' | 'fluxer';
export const PLATFORMS: Platform[] = ['discord', 'haven', 'fluxer'];

export interface Source {
  readonly platform: Platform;
  readonly id: string;
  /** Push interleaved 48k stereo float32 PCM (any length; re-framed by clock). */
  push(pcm: Float32Array): void;
  stop(): void;
}

/** Fixed-size jitter ring (power-free wrap arithmetic, silence on starvation). */
class Ring {
  private cap: number;
  private data: Float32Array;
  len = 0;
  private w = 0;
  private r = 0;
  constructor(seconds: number) {
    this.cap = FRAME_FLOATS * Math.max(1, Math.round((SAMPLE_RATE * seconds) / FRAME_SAMPLES));
    this.data = new Float32Array(this.cap);
  }
  get free() {
    return this.cap - this.len;
  }
  write(src: Float32Array): number {
    const space = this.free;
    if (space === 0) return src.length;
    const count = Math.min(space, src.length);
    const first = Math.min(count, this.cap - this.w);
    this.data.set(src.subarray(0, first), this.w);
    if (count - first > 0) this.data.set(src.subarray(first, count), 0);
    this.w = (this.w + count) % this.cap;
    this.len += count;
    return src.length - count;
  }
  /** Read exactly dst.length samples; true when the ring actually supplied them. */
  read(dst: Float32Array): boolean {
    if (this.len < dst.length) return false;
    const count = dst.length;
    const first = Math.min(count, this.cap - this.r);
    dst.set(this.data.subarray(this.r, this.r + first), 0);
    if (count - first > 0) dst.set(this.data.subarray(0, count - first), first);
    this.r = (this.r + count) % this.cap;
    this.len -= count;
    return true;
  }
}

export interface Outlet {
  id: string;
  /** Can this outlet hear the given stream? (mix-minus rule) */
  accepts(platform: Platform, id: string): boolean;
  /**
   * Called every 20 ms tick, even when `active` is false (silence), so legs
   * can keep encoder timelines and keepalive pacing continuous.
   */
  onFrame(frame: Float32Array, active: boolean): void;
  enabled: boolean;
}

export interface MixerEvents {
  onSpeaking(platform: Platform, id: string, speaking: boolean): void;
}

export interface MixerOptions {
  /** Drop incoming audio when the ring already queues more than this (ms). */
  maxLagMs?: number;
  /** Ring depth in seconds — this IS the added buffering latency. */
  ringSeconds?: number;
  events?: Partial<MixerEvents>;
}

interface StreamState {
  ring: Ring;
  frame: Float32Array; // scratch, refilled each tick
  source: Source;
  dropped: number;
}

export class Mixer {
  private streams = new Map<string, StreamState>();
  private outlets = new Map<string, Outlet>();
  private tickTimer: NodeJS.Timeout | null = null;
  private speakingState = new Map<string, boolean>();
  private speakingTimer = new Map<string, NodeJS.Timeout>();
  private opts: Required<Omit<MixerOptions, 'events'>> & { events: Partial<MixerEvents> };
  private frameCount = 0;

  /** Platform input gating from bridge mode flags ({in} side). */
  public enabledSrc: Record<Platform, boolean> = { discord: true, haven: true, fluxer: true };

  constructor(opts: MixerOptions = {}) {
    this.opts = { maxLagMs: 120, ringSeconds: 0.3, events: {}, ...opts };
  }

  createSource(platform: Platform, id: string): Source {
    const key = `${platform}:${id}`;
    this.removeSource(platform, id);
    const state: StreamState = {
      ring: new Ring(this.opts.ringSeconds),
      frame: new Float32Array(FRAME_FLOATS),
      source: null as unknown as Source,
      dropped: 0,
    };
    const self = this;
    const source: Source = {
      platform,
      id,
      push(pcm: Float32Array) {
        if ((state.ring.len / FRAME_FLOATS) * FRAME_MS > self.opts.maxLagMs) {
          state.dropped += pcm.length;
          return; // stale producer must not inflate latency
        }
        state.dropped += state.ring.write(pcm);
        if (pcm.length > 0) self.detectSpeaking(platform, id, pcm);
      },
      stop() {
        self.removeSource(platform, id);
      },
    };
    state.source = source;
    this.streams.set(key, state);
    return source;
  }

  removeSource(platform: Platform, id: string): void {
    this.streams.delete(`${platform}:${id}`);
    const key = `${platform}:${id}`;
    this.setSpeaking(platform, id, false);
    const t = this.speakingTimer.get(key);
    if (t) clearTimeout(t);
    this.speakingTimer.delete(key);
  }

  addOutlet(outlet: Outlet): void {
    this.outlets.set(outlet.id, outlet);
  }

  removeOutlet(id: string): void {
    this.outlets.delete(id);
  }

  private detectSpeaking(platform: Platform, id: string, pcm: Float32Array): void {
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 16) {
      const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
      if (v > peak) peak = v;
    }
    if (peak > 0.02) {
      this.setSpeaking(platform, id, true);
      const key = `${platform}:${id}`;
      const old = this.speakingTimer.get(key);
      if (old) clearTimeout(old);
      this.speakingTimer.set(
        key,
        setTimeout(() => {
          this.setSpeaking(platform, id, false);
          this.speakingTimer.delete(key);
        }, 700)
      );
    }
  }

  private setSpeaking(platform: Platform, id: string, speaking: boolean): void {
    const key = `${platform}:${id}`;
    if (this.speakingState.get(key) === speaking) return;
    this.speakingState.set(key, speaking);
    this.opts.events.onSpeaking?.(platform, id, speaking);
  }

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), FRAME_MS);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const t of this.speakingTimer.values()) clearTimeout(t);
    this.speakingTimer.clear();
  }

  /** Exposed for tests. */
  tick(): void {
    this.frameCount++;

    // 1) drain each stream into its own 20 ms frame
    const ready: { platform: Platform; id: string; frame: Float32Array }[] = [];
    for (const [key, state] of this.streams) {
      const [platform, id] = key.split(':') as [Platform, string];
      if (!this.enabledSrc[platform]) continue;
      if (state.ring.read(state.frame)) ready.push({ platform, id, frame: state.frame });
    }

    // 2) per-outlet mix-minus sum (never a soft-clip of one's own audio)
    for (const outlet of this.outlets.values()) {
      if (!outlet.enabled) continue;
      const out = new Float32Array(FRAME_FLOATS);
      let active = false;
      for (const src of ready) {
        if (src.platform === 'haven' && !outlet.accepts(src.platform, src.id)) continue;
        if (!outlet.accepts(src.platform, src.id)) continue;
        active = true;
        const f = src.frame;
        for (let i = 0; i < FRAME_FLOATS; i++) {
          let v = out[i] + f[i];
          if (v > 1) v = 1;
          else if (v < -1) v = -1;
          out[i] = v;
        }
      }
      outlet.onFrame(out, active);
    }
  }

  get streamsCount(): number {
    return this.streams.size;
  }
  get outletsCount(): number {
    return this.outlets.size;
  }
  get frames(): number {
    return this.frameCount;
  }

  /** Debug snapshot for periodic stats log. */
  stats(): { streams: number; droppedPerStream: Record<string, number> } {
    const droppedPerStream: Record<string, number> = {};
    for (const [key, s] of this.streams) if (s.dropped > 0) droppedPerStream[key] = s.dropped;
    return { streams: this.streams.size, droppedPerStream };
  }
}
