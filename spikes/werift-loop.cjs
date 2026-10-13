/* Werift loopback spike: proves the primitives the Haven leg needs:
 *  1. ICE + DTLS negotiation between two werift peers (host candidates only)
 *  2. TX: opus payload -> RtpPacket -> track.writeRtp -> sender path
 *  3. RX: remote track onReceiveRtp -> opus payload -> decode to PCM
 * Run: node spikes/werift-loop.cjs */
'use strict';
const {
  RTCPeerConnection,
  useOPUS,
  MediaStreamTrack,
  RtpPacket,
  RtpHeader,
} = require('werift');
const Opus = require('opusscript');

const enc = new Opus(48000, 2, Opus.Application.VOIP);
const dec = enc; // opusscript instance does both encode and decode

function opusFrame(phase) {
  // 20 ms of a sine as PCM16, encoded to opus
  const pcm = Buffer.alloc(960 * 2 * 2);
  for (let i = 0; i < 960; i++) {
    const v = Math.round(12000 * Math.sin((2 * Math.PI * 440 * (phase + i)) / 48000));
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  return enc.encode(pcm, 960); // frameSize = samples per channel
}

function makePc(tag) {
  return new RTCPeerConnection({
    iceServers: [],
    codecs: { audio: [useOPUS({ clockRate: 48000, channels: 2 })] },
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function waitGather(pc) {
  return new Promise((r) => {
    if (pc.iceGatheringState === 'complete') return r();
    pc.iceGatheringStateChange.subscribe((s) => s === 'complete' && r());
    setTimeout(r, 2000);
  });
}

async function pipeIce(a, b) {
  a.onIceCandidate.subscribe((c) => {
    if (c && c.candidate) b.addIceCandidate(c.candidate).catch((e) => console.log('iceB', e.message));
  });
  b.onIceCandidate.subscribe((c) => {
    if (c && c.candidate) a.addIceCandidate(c.candidate).catch((e) => console.log('iceA', e.message));
  });
}

function waitConnected(pc, tag) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${tag} connect timeout`)), 8000);
    pc.connectionStateChange.subscribe((s) => {
      console.log(`[${tag}] connectionState=${s}`);
      if (s === 'connected') { clearTimeout(t); res(); }
      if (s === 'failed') { clearTimeout(t); rej(new Error(`${tag} failed`)); }
    });
  });
}

async function main() {
  const a = makePc('A');
  const b = makePc('B');

  // A: local sender track (the way the bridge pushes mixed audio out)
  const aTrack = new MediaStreamTrack({ kind: 'audio' });
  a.addTransceiver(aTrack, { direction: 'sendrecv' });

  // B: also sendrecv so its receiver negotiates symmetric
  const bTrack = new MediaStreamTrack({ kind: 'audio' });
  b.addTransceiver(bTrack, { direction: 'sendrecv' });

  await pipeIce(a, b);

  let bRemote = null;
  const gotTrack = new Promise((r) => {
    b.onTrack.subscribe((t) => { console.log('[B] onTrack', t.kind, 'remote=', t.remote); bRemote = t; r(t); });
  });

  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await waitGather(a);
  await b.setRemoteDescription({ type: 'offer', sdp: a.localDescription.sdp });
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await waitGather(b);
  await a.setRemoteDescription({ type: 'answer', sdp: b.localDescription.sdp });

  await Promise.all([waitConnected(a, 'A'), waitConnected(b, 'B')]);
  await gotTrack;

  // RX probe on B
  const rx = new Promise((r) => {
    let n = 0;
    bRemote.onReceiveRtp.subscribe((pkt) => {
      n++;
      if (n === 1) console.log('[B] first RTP pt=' + pkt.header.payloadType + ' bytes=' + pkt.payload.length + ' ts=' + pkt.header.timestamp);
      if (n === 10) {
        const pcm = dec.decode(Buffer.from(pkt.payload));
        let peak = 0;
        if (pcm) for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
        r({ n, decodedSamples: pcm ? pcm.length / 2 / 2 : 0, peak });
      }
    });
    setTimeout(() => r({ n, decodedSamples: 0, peak: 0 }), 6000);
  });

  // TX: push 10 opus frames like the mixer tick would (timestamp += 960/20ms @48k)
  let ts = (Math.random() * 2 ** 32) >>> 0;
  let seq = 1000;
  for (let i = 0; i < 10; i++) {
    const payload = opusFrame(i * 960);
    const pkt = new RtpPacket(new RtpHeader({ sequenceNumber: seq++, timestamp: ts, ssrc: 0x1234, marker: false }), Buffer.from(payload));
    aTrack.writeRtp(pkt);
    ts = (ts + 960) >>> 0;
    await wait(20);
  }

  const result = await rx;
  console.log(`RESULT: received=${result.n}/10 decodedSamples=${result.decodedSamples} peak=${result.peak}`);
  console.log(result.n >= 8 && result.peak > 500 ? 'SPIKE PASS: opus tx/rx over werift works' : 'SPIKE FAIL');
  a.close(); b.close();
  process.exit(0);
}

main().catch((e) => { console.error('SPIKE ERROR:', e); process.exit(1); });
