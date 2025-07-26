import React, { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const HUB_URL = 'http://localhost:3000';
const STUN    = [{ urls: 'stun:stun.l.google.com:19302' }];

export default function EyetrackerClient() {
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);

  const pcRef     = useRef(null);
  const dcRef     = useRef(null);
  const socketRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [gaze,  setGaze]  = useState([10, 0]);
  const [blink, setBlink] = useState(false);

  /* ───── socket.io ───── */
  useEffect(() => {
    /* transports 옵션 제거 → polling → websocket 업그레이드 경로 사용 */
    socketRef.current = io(HUB_URL);

    socketRef.current.on('connect', () => {
      console.log('[Client] socket connected', socketRef.current.id);
      setupPeer();                         // offer 발사
    });

    socketRef.current.on('connect_error', (err) =>
      console.warn('[Client] connect_error', err.message));

    socketRef.current.on('ping-offset', () =>
      socketRef.current.emit('pong-offset', Date.now() / 1000));

    socketRef.current.on('server-answer',
      (answer) => pcRef.current.setRemoteDescription(answer));

    socketRef.current.on('ice-candidate',
      (cand)  => pcRef.current.addIceCandidate(cand));

    socketRef.current.on('ready', () => setReady(true));

    socketRef.current.on('gpu-result', ({ gaze, blink }) => {
      setGaze([gaze.x, gaze.y]);
      setBlink(blink);
    });

    return () => socketRef.current.disconnect();
  }, []);

  /* ───── WebRTC peer ───── */
  async function setupPeer() {
    const pc = new RTCPeerConnection({ iceServers: STUN });
    pcRef.current = pc;

    pc.onicecandidate = ({ candidate }) =>
      candidate && socketRef.current.emit('ice-candidate', candidate);

    dcRef.current = pc.createDataChannel('meta');

    await startCapture(pc);

    await pc.setLocalDescription(await pc.createOffer());
    socketRef.current.emit('client-offer', pc.localDescription);
  }

  /* ───── webcam → ROI ───── */
  async function startCapture(pc) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    videoRef.current.srcObject = stream;
    await videoRef.current.play();

    const ctx = canvasRef.current.getContext('2d');
    const ROI = 256;
    let fid   = 0;

    const draw = () => {
      const v = videoRef.current;
      if (v.readyState < 2) return requestAnimationFrame(draw);

      const side = Math.min(v.videoWidth, v.videoHeight);
      ctx.drawImage(
        v,
        (v.videoWidth  - side) / 2,
        (v.videoHeight - side) / 2,
        side, side,
        0, 0, ROI, ROI
      );

      if (dcRef.current.readyState === 'open') {
        dcRef.current.send(JSON.stringify({ fid: fid++, ts: Date.now() / 1000 }));
      }
      requestAnimationFrame(draw);
    };
    draw();

    const cStream = canvasRef.current.captureStream(30);
    cStream.getTracks().forEach((t) => pc.addTrack(t, cStream));
  }

  /* ───── UI ───── */
  return (
    <div style={{ padding: 16 }}>
      <h3>Eyetracker Demo</h3>
      <video ref={videoRef} width={220} muted playsInline style={{ background:'#000' }}/>
      <canvas ref={canvasRef} width={256} height={256} style={{ display:'none' }}/>
      <div style={{ marginTop:10 }}>
        {ready
          ? <>gaze {gaze[0].toFixed(2)}, {gaze[1].toFixed(2)} / blink {blink ? '🙈' : '👀'}</>
          : '허브 준비 대기 중…'}
      </div>
    </div>
  );
}
