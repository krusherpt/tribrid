import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mixer, FRAME_FLOATS, FRAME_SAMPLES } from '../audio/engine.js';
import { makeDecoder, makeEncoder, floatToS16, pcm16ToFloatStereo, codecBackend } from '../audio/codec.js';

test('mixer: mix-minus never echoes a platform to itself', () => {
  const mixer = new Mixer();
  const got: Record<string, Float32Array[]> = { discord: [], haven: [], fluxer: [] };
  // Platform-wide outlets (discord/fluxer style) + per-user haven outlet
  const mk = (id: string, excludes: (p: string, u: string) => boolean) =>
    mixer.addOutlet({
      id,
      enabled: true,
      accepts: (p, u) => !excludes(p, u),
      onFrame(f) {
        (got[id] ??= []).push(Float32Array.from(f));
      },
    });
  mixer.addOutlet({ id: 'discord', enabled: true, accepts: (p) => p !== 'discord', onFrame: (f) => got.discord.push(Float32Array.from(f)) });
  void mk;

  const dSrc = mixer.createSource('discord', 'u1');
  const hSrc = mixer.createSource('haven', '7');

  // push loud audio for 1 frame worth of samples each
  const loud = new Float32Array(FRAME_FLOATS).fill(0.5);
  dSrc.push(loud);
  hSrc.push(Float32Array.from(loud));

  mixer.tick();
  mixer.tick(); // ensure ring drained once

  const dFrame = got.discord.find((f) => f.some((v) => v !== 0));
  assert.ok(dFrame, 'discord outlet received non-zero audio');
  assert.ok(Math.abs(dFrame![0]! - 0.5) < 0.01, `haven audio routed to discord (got ${dFrame![0]})`);

  // haven has no outlet registered here, but fluxer outlet absent too;
  // the key assertion: nothing from discord should reach a hypothetical
  // discord-only outlet — covered by accepts(); now check haven per-user:
  const hGot: Float32Array[] = [];
  mixer.addOutlet({
    id: 'haven:7',
    enabled: true,
    accepts: (p, u) => !(p === 'haven' && u === '7'),
    onFrame: (f) => hGot.push(Float32Array.from(f)),
  });
  dSrc.push(Float32Array.from(loud));
  hSrc.push(Float32Array.from(loud));
  mixer.tick();
  const hf = hGot.find((f) => f.some((v) => v !== 0));
  assert.ok(hf, 'haven outlet got discord audio');
  assert.ok(Math.abs(hf![0]! - 0.5) < 0.01, `only discord's 0.5 present, not 1.0 (got ${hf![0]})`);
  mixer.stop();
});

test('mixer: soft-clip at +/-1', () => {
  const mixer = new Mixer();
  let last: Float32Array | null = null;
  mixer.addOutlet({ id: 'x', enabled: true, accepts: () => true, onFrame: (f) => (last = Float32Array.from(f)) });
  const a = mixer.createSource('discord', 'a');
  const b = mixer.createSource('haven', 'b');
  const loud = new Float32Array(FRAME_FLOATS).fill(0.8);
  a.push(loud);
  b.push(Float32Array.from(loud));
  mixer.tick();
  assert.ok(last);
  assert.ok((last as Float32Array)[0]! <= 1.0);
  mixer.stop();
});

test('codec: roundtrip 48k stereo float -> opus -> float', () => {
  assert.notEqual(codecBackend, 'none');
  const enc = makeEncoder();
  const dec = makeDecoder();
  const frame = new Float32Array(FRAME_FLOATS);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.4;
    frame[i * 2] = v;
    frame[i * 2 + 1] = v;
  }
  const opus = enc.encode(floatToS16(frame));
  assert.ok(opus.length > 0);
  const pcm = dec.decode(opus);
  assert.ok(pcm && pcm.length === FRAME_FLOATS, `decoded ${pcm?.length} samples`);
  const back = pcm16ToFloatStereo(pcm!);
  let peak = 0;
  for (const v of back) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.2 && peak < 0.6, `sine survives codec (peak ${peak})`);
});

test('mixer: stale producer drops instead of inflating latency', () => {
  const mixer = new Mixer({ maxLagMs: 40 });
  let frames = 0;
  mixer.addOutlet({ id: 'x', enabled: true, accepts: () => true, onFrame: () => frames++ });
  const s = mixer.createSource('discord', 'slow');
  const loud = new Float32Array(FRAME_FLOATS).fill(0.1);
  // push 2 s of audio in one go — beyond the ring: must not accumulate unbounded
  for (let i = 0; i < 100; i++) s.push(loud);
  const stats = mixer.stats();
  const dropped = stats.droppedPerStream['discord:slow'] ?? 0;
  assert.ok(dropped > 0, 'excess samples were dropped');
  mixer.stop();
  void frames;
});
