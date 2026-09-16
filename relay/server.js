/*
 * BG-ProMIDI live-viewer relay
 * -----------------------------
 * A tiny, dependency-light WebSocket relay. One BG-ProMIDI page (the
 * "broadcaster" -- the machine actually reading Pro Tools' HUI SysEx)
 * pushes small JSON snapshots of what's on screen; any number of
 * "viewer" pages watching the same session code receive them live and
 * just mirror the HTML into their own display. The relay never touches
 * MIDI and does no HUI decoding itself -- it only forwards already-
 * rendered state between browsers.
 *
 * No database and no login: a session code IS the access control, the
 * same way a shareable link is. Treat the URL you hand someone like
 * any other shareable link -- anyone who has it can watch.
 *
 * Run:   npm install && npm start
 * Env:   PORT (default 8787)
 */
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;

// ---- tunables -------------------------------------------------------
const MAX_ROOMS = 200;              // soft cap on concurrent sessions
const MAX_CONNECTIONS = 400;        // soft cap on total sockets
const MAX_MESSAGE_BYTES = 32 * 1024; // a rendered-HTML snapshot is a few KB; 32KB is generous headroom
const RATE_LIMIT_MSGS = 25;         // per socket
const RATE_LIMIT_WINDOW_MS = 1000;
const ROOM_IDLE_SWEEP_MS = 5 * 60 * 1000; // drop empty/stale rooms every 5 min
const ROOM_IDLE_TTL_MS = 30 * 60 * 1000;  // a room with no broadcaster and no viewers for 30 min is dropped
const HEARTBEAT_MS = 30 * 1000;

// ---- state ------------------------------------------------------------
/** @type {Map<string, { broadcaster: import('ws').WebSocket|null, viewers: Set<import('ws').WebSocket>, lastState: any, updatedAt: number }>} */
const rooms = new Map();
let totalConnections = 0;

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return null;
    room = { broadcaster: null, viewers: new Set(), lastState: null, updatedAt: Date.now() };
    rooms.set(code, room);
  }
  return room;
}

function sweepRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const empty = !room.broadcaster && room.viewers.size === 0;
    if (empty && now - room.updatedAt > ROOM_IDLE_TTL_MS) rooms.delete(code);
  }
}
setInterval(sweepRooms, ROOM_IDLE_SWEEP_MS).unref();

// ---- HTTP (health check only -- the app itself is static-hosted elsewhere) ----
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'bgpromidi-relay',
      rooms: rooms.size,
      connections: totalConnections,
    }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  if (totalConnections >= MAX_CONNECTIONS) {
    ws.close(1013, 'relay at capacity, try again shortly');
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const role = url.searchParams.get('role');   // 'broadcast' | 'view'
  const code = (url.searchParams.get('session') || '').trim();

  if ((role !== 'broadcast' && role !== 'view') || !/^[A-Za-z0-9]{4,32}$/.test(code)) {
    ws.close(1008, 'expected ?role=broadcast|view&session=<code>');
    return;
  }

  const room = getOrCreateRoom(code);
  if (!room) {
    ws.close(1013, 'relay at capacity, try again shortly');
    return;
  }

  totalConnections++;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // simple per-socket rate limiter (token bucket, refilled every window)
  let tokens = RATE_LIMIT_MSGS;
  const refill = setInterval(() => { tokens = RATE_LIMIT_MSGS; }, RATE_LIMIT_WINDOW_MS);

  if (role === 'broadcast') {
    // Last writer wins -- if someone else is already broadcasting to
    // this code, they get bumped. Keeps the relay stateless/simple;
    // fine for "one person shares their session at a time".
    if (room.broadcaster && room.broadcaster !== ws) {
      try { room.broadcaster.close(4000, 'another broadcaster took over this session'); } catch (_) {}
    }
    room.broadcaster = ws;
    ws.role = 'broadcast';
    ws.roomCode = code;
    broadcastToViewers(room, { type: 'broadcaster-joined' });
  } else {
    room.viewers.add(ws);
    ws.role = 'view';
    ws.roomCode = code;
    // Late joiners get whatever the last known snapshot was, immediately.
    if (room.lastState) safeSend(ws, room.lastState);
    else safeSend(ws, { type: 'waiting', message: 'Connected -- waiting for the broadcaster to start sharing.' });
  }

  ws.on('message', (buf) => {
    if (ws.role !== 'broadcast') return; // viewers never send state
    if (buf.length > MAX_MESSAGE_BYTES) return; // silently drop oversized frames
    if (tokens <= 0) return; // rate limited
    tokens--;

    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch (_) { return; }
    if (!msg || typeof msg !== 'object' || msg.type !== 'state') return;

    room.lastState = msg;
    room.updatedAt = Date.now();
    broadcastToViewers(room, msg);
  });

  ws.on('close', () => {
    clearInterval(refill);
    totalConnections--;
    if (ws.role === 'broadcast' && room.broadcaster === ws) {
      room.broadcaster = null;
      room.updatedAt = Date.now();
      broadcastToViewers(room, { type: 'broadcaster-left' });
    } else if (ws.role === 'view') {
      room.viewers.delete(ws);
    }
  });

  ws.on('error', () => { try { ws.close(); } catch (_) {} });
});

function broadcastToViewers(room, msg) {
  const payload = JSON.stringify(msg);
  for (const viewer of room.viewers) safeSend(viewer, payload, true);
}

function safeSend(ws, msg, alreadyStringified) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(alreadyStringified ? msg : JSON.stringify(msg)); } catch (_) {}
}

// Heartbeat: drop dead sockets (e.g. a laptop that went to sleep
// without a clean close) so rooms/connection counts stay accurate.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, HEARTBEAT_MS);
heartbeat.unref();

server.listen(PORT, () => {
  console.log(`BG-ProMIDI relay listening on :${PORT}  (ws path: /ws, health: /health)`);
});
