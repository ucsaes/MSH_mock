// hub.js
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { RTCPeerConnection, RTCIceCandidate } = require('@koush/wrtc');
const WebSocket = require('ws');

const PORT     = 3000;                 // 클라이언트용
const GPU_HTTP = 'http://localhost:5000';
const STUN     = [{ urls:'stun:stun.l.google.com:19302' }];

// ───── HTTP + socket.io ──────────────────────────────────────────────
const app = express(); app.use(express.json());
const srv = http.createServer(app);
const io  = new Server(srv, { cors:{ origin:'*' } });
srv.listen(PORT, () => console.log(`🔌 Hub listening on :${PORT}`));

// ───── GPU WS (포트 3001 분리) ───────────────────────────────────────
let gpuSock = null;
const wss = new WebSocket.Server({ port: 3001 });
wss.on('connection', (ws) => {
  console.log('✅ GPU WS connected');
  gpuSock = ws;
  ws.on('message', (m) => {
    const { clientId, gaze, blink, frameId } = JSON.parse(m);
    io.to(clientId).emit('gpu-result', { gaze, blink, frameId });
  });
  ws.on('close', () => { console.warn('⚠️ GPU WS closed'); gpuSock = null; });
});

// ───── 세션 관리 ────────────────────────────────────────────────────
const sessions = new Map();
const measureOffset = (sock) => new Promise((ok) => {
  const T0 = Date.now()/1000;
  sock.emit('ping-offset', T0);
  sock.once('pong-offset', (T1) => {
    const T2 = Date.now()/1000;
    ok(((T1-T0)+(T1-T2))/2);
  });
});

// ───── socket.io (Client ↔ Hub) ─────────────────────────────────────
io.on('connection', async (sock) => {
  console.log('👤 Client', sock.id);

  const offset = await measureOffset(sock);
  sessions.set(sock.id, { offset });

  sock.on('client-offer', async (offer) => {
    const state = sessions.get(sock.id);
    state.pcClient = new RTCPeerConnection({ iceServers: STUN });

    state.pcClient.onicecandidate = ({ candidate }) =>
      candidate && sock.emit('ice-candidate', candidate);

    state.pcClient.ontrack = ({ track, streams }) => {
      if (!state.pcGpu) createGpuPeer(state, sock.id, track, streams[0]);
    };

    await state.pcClient.setRemoteDescription(offer);
    await state.pcClient.setLocalDescription(await state.pcClient.createAnswer());
    sock.emit('server-answer', state.pcClient.localDescription);
  });

  sock.on('ice-candidate', (c) =>
    sessions.get(sock.id)?.pcClient.addIceCandidate(new RTCIceCandidate(c)));

  sock.on('disconnect', () => {
    console.log('⛔', sock.id, 'disconnected');
    const s = sessions.get(sock.id);
    s?.pcClient?.close(); s?.pcGpu?.close();
    sessions.delete(sock.id);
  });
});

// ───── Hub ↔ GPU Peer ───────────────────────────────────────────────
async function createGpuPeer(state, clientId, track, stream) {
  const pc = new RTCPeerConnection({ iceServers: STUN });
  state.pcGpu = pc;
  pc.addTrack(track, stream);

  pc.onicecandidate = ({ candidate }) =>
    candidate && fetch(`${GPU_HTTP}/ice-candidate`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ clientId, candidate })
    });

  await pc.setLocalDescription(await pc.createOffer());

  const res = await fetch(`${GPU_HTTP}/connect`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({
      clientId,
      offset: state.offset,
      sdp:    pc.localDescription.sdp,
      type:   pc.localDescription.type
    })
  });
  const { sdp, type } = await res.json();
  await pc.setRemoteDescription({ sdp, type });

  console.log('🔗 Hub-GPU peer ready');
  io.to(clientId).emit('ready');
}
