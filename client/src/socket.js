import { io } from 'socket.io-client';

// One Socket.IO connection per page, to the same origin (Vite proxies /socket.io in dev).
let socket = null;
export function getSocket() {
  if (!socket) socket = io({ transports: ['websocket', 'polling'] });
  return socket;
}

// Promise wrapper around an emit with acknowledgement (rejects after a timeout).
export function emitAck(event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    getSocket().timeout(timeoutMs).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

// Stable anonymous id for this browser (used to tell crowd reports apart; never personal data).
export function clientId() {
  try {
    let id = localStorage.getItem('rescue.clientId');
    if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('rescue.clientId', id); }
    return id;
  } catch { return 'anon'; }
}
