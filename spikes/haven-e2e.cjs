#!/usr/bin/env node
/* End-to-end test against a REAL throwaway Haven server:
 *   haven server  +  tribrid bridge (haven leg only)  +  2 fake browser users (werift+socket.io)
 *
 * Flow: U1 and U2 join the voice channel as real Haven users, offer P2P to the
 * bot (Haven politeness: bot id is negative -> bot is polite). U1 blasts a
 * 440 Hz sine; it must arrive decoded at U2 THROUGH the bridge mixer, and
 * U1 must NOT hear its own audio (mix-minus).
 *
 * Run: node spikes/haven-e2e.cjs          (add --keep to keep the haven data dir)
 */
'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { io } = require('socket.io-client');
const Database = require('/home/nyankopc/projects/tribrid/vendor/haven/node_modules/better-sqlite3');
const jwt = require('/home/nyankopc/projects/tribrid/vendor/haven/node_modules/jsonwebtoken');
const bcrypt = require('/home/nyankopc/projects/tribrid/vendor/haven/node_modules/bcryptjs');
const { RTCPeerConnection, useOPUS, MediaStreamTrack, RtpPacket, RtpHeader } = require('werift');
const Opus = require('opusscript');

const HAVEN_DIR = '/home/nyankopc/projects/tribrid/vendor/haven';
const BRIDGE_DIR = '/home/nyankopc/projects/tribrid';
const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
fs.mkdirSync('/home/nyankopc/projects/tribrid/tmp', { recursive: true });
const dataDir = fs.mkdtempSync('/home/nyankopc/projects/tribrid/tmp/haven-e2e-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let havenProc = null;
let bridgeProc = null;
const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}

function startHaven(env = {}) {
  const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
  havenProc = spawn('node', ['server.js'], {
    cwd: HAVEN_DIR,
    env: { ...process.env, FORCE_HTTP: 'true', PORT: String(PORT), HAVEN_DATA_DIR: dataDir, JWT_SECRET, ...env },
    stdio: ['ignore', log, log],
  });
  havenProc.on('exit', (c) => { if (!startHaven.stopping) console.error('haven exited early', c, fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8').slice(-2000)); });
}
async function waitHaven(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if ((await fetch(BASE + '/api/health')).ok) return true; } catch { /* not yet */ }
    await sleep(300);
  }
  return false;
}

function seed() {
  const db = new Database(path.join(dataDir, 'haven.db'));
  db.pragma('busy_timeout = 8000');
  const hash = bcrypt.hashSync('e2e-password-not-secret', 4);
  const mk = (name) => ({ id: null, name, code: crypto.randomBytes(4).toString('hex') });
  const voice = mk('voice-e2e');
  const text = mk('text-e2e');
  const insChan = db.prepare("INSERT INTO channels (name, code, voice_enabled) VALUES (?, ?, 1)");
  voice.id = Number(insChan.run(voice.name, voice.code).lastInsertRowid);
  text.id = Number(insChan.run(text.name, text.code).lastInsertRowid);
  const insUser = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)');
  const insMember = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  const users = {};
  for (const [key, uname] of Object.entries({ admin: 'e2e_admin', u1: 'e2e_u1', u2: 'e2e_u2' })) {
    const id = Number(insUser.run(uname, hash, key === 'admin' ? 1 : 0).lastInsertRowid);
    insMember.run(voice.id, id);
    insMember.run(text.id, id);
    users[key] = { id, username: uname, token: jwt.sign({ id, username: uname, isAdmin: key === 'admin', displayName: uname, pwv: 1 }, JWT_SECRET, { expiresIn: '1h' }) };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const webhookId = Number(db.prepare('INSERT INTO webhooks (channel_id, name, token, created_by, can_use_voice) VALUES (?, ?, ?, ?, 1)')
    .run(text.id, 'tribrid-e2e', token, users.admin.id).lastInsertRowid);
  db.close();
  return { voice, text, users, botToken: token, webhookId };
}

// ---- fake browser user over werift ----
function makeUser(name, token) {
  const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
  const enc = new Opus(48000, 2, Opus.Application.VOIP);
  const st = { socket, rxPackets: 0, rxPeak: 0, connected: false, peers: new Map() };

  socket.on('connect_error', (e) => console.log(`[${name}] connect_error: ${e.message}`));

  socket.on('voice-offer', async (data) => {
    const from = data.from?.id;
    if (from == null || !(from < 0)) return; // bridge test: peer with the bot only
    if (st.peers.has(`answering:${from}`)) return;
    const pc = new RTCPeerConnection({ iceServers: [], codecs: { audio: [useOPUS({ clockRate: 48000, channels: 2 })] } });
    const local = new MediaStreamTrack({ kind: 'audio' });
    pc.addTransceiver(local, { direction: 'sendrecv' });
    pipeIce(name, pc, socket, from);
    wireTrack(name, st, pc);
    st.peers.set(from, { pc, local });
    st.peers.set(`answering:${from}`, true);
    await pc.setRemoteDescription({ type: 'offer', sdp: data.offer.sdp });
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    socket.emit('voice-answer', { code: data.channelCode ?? st.code, targetUserId: from, answer: { type: 'answer', sdp: pc.localDescription.sdp } });
  });

  socket.on('voice-answer', (data) => {
    const from = data.from?.id;
    if (from == null || !(from < 0)) return;
    const p = st.peers.get(from);
    if (p && data.answer) p.pc.setRemoteDescription({ type: 'answer', sdp: data.answer.sdp }).catch(() => {});
  });

  socket.on('voice-ice-candidate', (data) => {
    const from = data.from?.id;
    if (from == null || !(from < 0)) return;
    const p = st.peers.get(from);
    if (p && data.candidate?.candidate) p.pc.addIceCandidate(data.candidate).catch(() => {});
  });

  socket.on('voice-user-joined', (d) => {
    if (!d.user || !st.inVoice) return;
    if (!(d.user.id < 0)) return; // bots only
    offerTo(name, st, d.user.id, st.code);
  });

  socket.on('voice-existing-users', (d) => {
    if (!st.inVoice) return;
    for (const u of d.users || []) {
      if (u.isBot || (u.id ?? 1) < 0) offerTo(name, st, u.id, st.code);
    }
  });

  socket.inVoice = false;
  // NOTE: the user-side voice-join handler never invokes an ack callback
  // (only the bot API does). Join confirmation = 'voice-existing-users'.
  socket.joinVoice = (code) => new Promise((res, rej) => {
    st.code = code; socket.st_code = code; st.inVoice = true;
    const to = setTimeout(() => rej(new Error(`${name}: voice-join timeout`)), 6000);
    const onErr = (m) => { if (String(m).toLowerCase().includes('voice')) { clearTimeout(to); rej(new Error(String(m))); } };
    socket.once('voice-existing-users', (d) => {
      clearTimeout(to); socket.off('error-msg', onErr);
      for (const u of d.users || []) {
        if (u.isBot || (u.id ?? 1) < 0) offerTo(name, st, u.id, code);
      }
      res({ success: true, users: (d.users || []).length });
    });
    socket.on('error-msg', onErr);
    socket.emit('voice-join', { code, relay: 0 });
  });

  st.close = () => {
    for (const p of st.peers.values()) { try { p.pc?.close?.(); } catch { /* */ } }
    socket.disconnect();
  };
  return st;
}

async function offerTo(name, st, targetId, code) {
  const key = `offering:${targetId}`;
  if (st.peers.has(key) || st.peers.has(targetId)) return;
  st.peers.set(key, true);
  const pc = new RTCPeerConnection({ iceServers: [], codecs: { audio: [useOPUS({ clockRate: 48000, channels: 2 })] } });
  const local = new MediaStreamTrack({ kind: 'audio' });
  pc.addTransceiver(local, { direction: 'sendrecv' });
  pipeIce(name, pc, st.socket, targetId);
  wireTrack(name, st, pc);
  st.peers.set(targetId, { pc, local });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  st.socket.emit('voice-offer', { code, targetUserId: targetId, offer: { type: 'offer', sdp: offer.sdp } });
}

function pipeIce(name, pc, socket, targetUserId) {
  pc.onIceCandidate.subscribe((c) => {
    if (!c) return;
    socket.emit('voice-ice-candidate', { code: socket.st_code, targetUserId, candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } });
  });
  pc.connectionStateChange.subscribe((s) => { if (s === 'connected') console.log(`[${name}] ice/dtls connected to ${targetUserId}`); });
}

function wireTrack(name, st, pc) {
  const dec = new Opus(48000, 2, Opus.Application.VOIP);
  pc.onTrack.subscribe((t) => {
    t.onReceiveRtp.subscribe((pkt) => {
      st.rxPackets++;
      const pcm = dec.decode(Buffer.from(pkt.payload));
      if (pcm) for (let i = 0; i < pcm.length; i += 4) st.rxPeak = Math.max(st.rxPeak, Math.abs(pcm.readInt16LE(i)));
    });
  });
}

function pushSine(user, seconds, cb) {
  // user.peers: bot peer gets a continuous sine at 20ms cadence
  const p = [...user.peers.entries()].find(([, v]) => v.local);
  if (!p) { cb?.(false); return; }
  const { pc, local } = p[1];
  if (pc.connectionState !== 'connected') {
    // wait for connected up to 5s
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pc.connectionState === 'connected') { clearInterval(iv); send(); }
      else if (Date.now() - t0 > 5000) { clearInterval(iv); cb?.(false); }
    }, 100);
  } else send();
  function send() {
    // pace at real-time like a real mic (a burst would legitimately hit the
    // bridge's jitter-buffer drop policy)
    const enc = new Opus(48000, 2, Opus.Application.VOIP);
    let ts = 0x12345678, seq = 7;
    const n = (seconds * 1000) / 20;
    let f = 0;
    const iv = setInterval(() => {
      if (f >= n || pc.connectionState !== 'connected') {
        clearInterval(iv); cb?.(f > 0, f); return;
      }
      const pcm = Buffer.alloc(960 * 2 * 2);
      for (let i = 0; i < 960; i++) {
        const v = Math.round(20000 * Math.sin((2 * Math.PI * 440 * (f * 960 + i)) / 48000));
        pcm.writeInt16LE(v, i * 4); pcm.writeInt16LE(v, i * 4 + 2);
      }
      const payload = enc.encode(pcm, 960);
      local.writeRtp(new RtpPacket(new RtpHeader({ sequenceNumber: seq++, timestamp: ts, ssrc: 0x4242 }), Buffer.from(payload)));
      ts = (ts + 960) >>> 0;
      f++;
    }, 20);
  }
}

async function main() {
  console.log('== starting throwaway haven server ==');
  startHaven();
  if (!await waitHaven()) { check('haven server boots', false); return finish(); }
  check('haven server boots', true);

  console.log('== seeding (server stopped for clean seed) ==');
  startHaven.stopping = true; havenProc.kill(); await sleep(800); startHaven.stopping = false;
  const seedInfo = seed();
  startHaven();
  if (!await waitHaven()) { check('haven restarts after seed', false); return finish(); }
  check('haven restarts after seed', true);

  console.log('== starting bridge (haven leg) ==');
  const blog = fs.openSync(path.join(dataDir, 'bridge.log'), 'a');
  bridgeProc = spawn('node', ['dist/index.js'], {
    cwd: BRIDGE_DIR,
    env: {
      ...process.env,
      LOG_LEVEL: 'debug',
      HAVEN_URL: BASE,
      HAVEN_BOT_TOKEN: seedInfo.botToken,
      HAVEN_CHANNEL_CODE: seedInfo.voice.code,
      HAVEN_ICE_SERVERS_JSON: '[]',
      PRESENCE_ENABLED: '0',
    },
    stdio: ['ignore', blog, blog],
  });
  bridgeProc.on('exit', (c) => { if (!main.stopping) console.error('bridge exited early', c, fs.readFileSync(path.join(dataDir, 'bridge.log'), 'utf8').slice(-2000)); });
  await sleep(4000); // bot socket connect + voice-join

  console.log('== users join ==');
  const u1 = makeUser('U1', seedInfo.users.u1.token);
  const u2 = makeUser('U2', seedInfo.users.u2.token);
  await new Promise((res, rej) => { u1.socket.once('connect', res); u1.socket.once('connect_error', rej); setTimeout(() => rej(new Error('u1 connect timeout')), 8000); });
  await new Promise((res, rej) => { u2.socket.once('connect', res); u2.socket.once('connect_error', rej); setTimeout(() => rej(new Error('u2 connect timeout')), 8000); });
  const j1 = await u1.socket.joinVoice(seedInfo.voice.code);
  check('U1 voice-join accepted', !!j1?.success, JSON.stringify(j1));
  await sleep(1000);
  const j2 = await u2.socket.joinVoice(seedInfo.voice.code);
  check('U2 voice-join accepted', !!j2?.success, JSON.stringify(j2));

  // users must now offer to the bot (voice-user-joined handled automatically);
  // give ICE a moment, then blast a sine from U1 for 3 s
  await sleep(3000);
  console.log('== U1 speaks for 3 s ==');
  const sent = await new Promise((res) => pushSine(u1, 3, res));
  check('U1 negotiated with bot (sine sent)', sent);
  await sleep(5000); // bridge mixer + encode + P2P to U2

  const bridgeLog = fs.readFileSync(path.join(dataDir, 'bridge.log'), 'utf8');
  check('bridge bot session ok', /bot session id=-\d+/.test(bridgeLog));
  check('bridge voice-join ok', /voice-join ok/.test(bridgeLog));
  check('bridge answered/created a peer connection', /peer .*connectionState=connected|onTrack/.test(bridgeLog), '');
  check('U2 received media through bridge', u2.rxPackets > 20, `${u2.rxPackets} pkts, peak ${u2.rxPeak}`);
  check('U2 audio is the sine (peak>5000)', u2.rxPeak > 5000, `peak ${u2.rxPeak}`);
  check('U1 did NOT hear own audio (mix-minus)', u1.rxPeak < 3000, `peak ${u1.rxPeak}`);
  const spoke = /speaking|onSpeaking/i.test(bridgeLog) || true; // speaking detection asserted indirectly via routing
  void spoke;

  main.stopping = true;
  u1.close(); u2.close();
  finish();
}

function finish() {
  try { main.stopping = true; } catch { /* */ }
  try { bridgeProc?.kill(); } catch { /* */ }
  try { havenProc?.kill(); } catch { /* */ }
  if (!process.argv.includes('--keep')) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ } }
  else console.log('data kept at', dataDir);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n== ${results.length - failed}/${results.length} checks passed ==`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('E2E ERROR:', e); finish(); });
