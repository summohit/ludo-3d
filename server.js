import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { LudoHost } from './shared/ludoHost.js';
import { sanitizeRules } from './shared/ludoEngine.js';

const PORT = process.env.PORT || 4174;
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 30_000;
const TURN_MS = Number(process.env.TURN_MS) || 60_000;
const EMPTY_ROOM_MS = Number(process.env.EMPTY_ROOM_MS) || 5 * 60_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Only these paths are served; server code and package files are not.
const PUBLIC_PREFIXES = ['/src/', '/shared/', '/node_modules/three/build/', '/node_modules/gsap/'];

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  const allowed = pathname === '/index.html' || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
  const safePath = path.normalize(path.join(ROOT_DIR, pathname));
  if (!allowed || !safePath.startsWith(ROOT_DIR + path.sep)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(safePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(safePath).pipe(res);
  });
});

// ---------------------------------------------------------------------------
// Rooms
// seat = { id (public), token (private), name, isBot, away, ready, ws, awayTimer }
// ---------------------------------------------------------------------------
const rooms = new Map();
const tokenToRoom = new Map();
const BOT_NAMES = ['Ruby (Bot)', 'Nova (Bot)', 'Apex (Bot)', 'Blaze (Bot)'];
const SEAT_ORDER = [0, 2, 1, 3]; // 2nd player sits opposite the first

const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const newId = () => crypto.randomBytes(6).toString('hex');
const isValidToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(t);
const isHuman = (s) => s && s.token;
const isConnected = (s) => isHuman(s) && s.ws && s.ws.readyState === 1;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function send(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function gameRunning(room) {
  return Boolean(room.game && !room.game.engine.gameOver);
}

function publicRoom(room) {
  const players = [];
  room.seats.forEach((s, seat) => {
    if (!s) return;
    players.push({
      id: s.id,
      name: s.name,
      seat,
      isBot: s.isBot,
      away: Boolean(s.away),
      ready: Boolean(s.ready),
      connected: s.isBot ? !s.away : isConnected(s),
    });
  });
  return {
    code: room.code,
    roomName: room.roomName,
    hostId: room.hostId,
    started: room.started,
    gameOver: Boolean(room.game && room.game.engine.gameOver),
    rules: room.rules,
    players,
  };
}

function sendRoom(room, s, seat, type) {
  send(s.ws, { type, room: publicRoom(room), seat, you: s.id });
}

function broadcastRoom(room) {
  room.seats.forEach((s, seat) => isConnected(s) && sendRoom(room, s, seat, 'room_updated'));
}

function broadcast(room, payload, exceptSeat = -1) {
  room.seats.forEach((s, seat) => seat !== exceptSeat && isConnected(s) && send(s.ws, payload));
}

function seatOf(room, ws) {
  return room.seats.findIndex((s) => s && !s.isBot && s.token === ws.token);
}

function deleteRoom(room) {
  if (room.game) room.game.stop();
  clearTimeout(room.emptyTimer);
  room.seats.forEach((s) => {
    if (s) clearTimeout(s.awayTimer);
    if (isHuman(s)) tokenToRoom.delete(s.token);
  });
  rooms.delete(room.code);
}

function maintainRoom(room) {
  const connected = room.seats.filter(isConnected);
  if (room.seats.filter(isHuman).length === 0) {
    deleteRoom(room);
    return false;
  }
  const host = room.seats.find((s) => s && s.id === room.hostId);
  if ((!host || !isHuman(host) || host.isBot) && connected.length > 0) room.hostId = connected[0].id;
  clearTimeout(room.emptyTimer);
  room.emptyTimer = connected.length === 0
    ? setTimeout(() => rooms.has(room.code) && deleteRoom(room), EMPTY_ROOM_MS)
    : null;
  return true;
}

function startGame(room) {
  if (room.game) room.game.stop();
  room.started = true;
  room.seats.forEach((s) => s && (s.ready = false));
  const game = new LudoHost({
    turnMs: TURN_MS,
    rules: room.rules,
    players: room.seats.map((s, seat) => ({
      name: s ? s.name : `Seat ${seat + 1}`,
      isBot: Boolean(s?.isBot),
      active: Boolean(s),
    })),
    send: (seat, payload) => {
      const s = room.seats[seat];
      if (isConnected(s)) send(s.ws, payload);
    },
  });
  room.game = game;
  room.seats.forEach((s, seat) => isConnected(s) && sendRoom(room, s, seat, 'match_started'));
  game.start();
}

function vacateSeat(room, seat) {
  const s = room.seats[seat];
  if (!s) return;
  clearTimeout(s.awayTimer);
  if (isHuman(s)) tokenToRoom.delete(s.token);
  if (gameRunning(room) && room.game.engine.players[seat].active) {
    const botName = `${s.name} (Bot)`.slice(0, 24);
    room.seats[seat] = { id: newId(), token: null, name: botName, isBot: true, away: false, ws: null };
    room.game.setBot(seat, true, botName);
  } else {
    room.seats[seat] = null;
  }
}

function markAway(room, seat) {
  const s = room.seats[seat];
  s.ws = null;
  s.away = true;
  if (gameRunning(room)) room.game.setAway(seat, true);
  clearTimeout(s.awayTimer);
  s.awayTimer = setTimeout(() => {
    if (!rooms.has(room.code) || room.seats[seat] !== s || !s.away) return;
    if (gameRunning(room)) {
      s.isBot = true; // a bot plays until they return; the seat stays theirs
      room.game.setBot(seat, true);
    } else {
      vacateSeat(room, seat);
    }
    if (maintainRoom(room)) broadcastRoom(room);
  }, RECONNECT_GRACE_MS);
  if (maintainRoom(room)) broadcastRoom(room);
}

function reattach(ws, room, seat) {
  const s = room.seats[seat];
  clearTimeout(s.awayTimer);
  if (s.ws && s.ws !== ws) {
    send(s.ws, { type: 'session_replaced' });
    s.ws.roomCode = null;
  }
  s.ws = ws;
  s.away = false;
  ws.roomCode = room.code;
  const wasBot = s.isBot;
  s.isBot = false;
  maintainRoom(room);
  sendRoom(room, s, seat, 'room_joined');
  if (room.game && room.started) {
    if (gameRunning(room)) {
      if (wasBot) room.game.setBot(seat, false, s.name);
      room.game.setAway(seat, false);
    }
    room.game.sendView(seat);
  }
  broadcastRoom(room);
}

function leaveRoom(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  ws.roomCode = null;
  if (!room) return;
  const seat = seatOf(room, ws);
  if (seat === -1) return;
  const name = room.seats[seat].name;
  vacateSeat(room, seat);
  if (maintainRoom(room)) {
    broadcast(room, { type: 'player_left', name, seat });
    broadcastRoom(room);
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

function broadcastOnlineCount() {
  const msg = JSON.stringify({ type: 'online_count', count: wss.clients.size });
  wss.clients.forEach((c) => c.readyState === 1 && c.send(msg));
}

function newHumanSeat(ws, name) {
  return { id: newId(), token: ws.token, name, isBot: false, away: false, ready: false, ws, awayTimer: null };
}

/** Names are required: 2–18 characters. */
function requireName(ws, raw) {
  const name = cleanText(raw, 18);
  if (name.length < 2) {
    send(ws, { type: 'room_error', message: 'Please enter your name (at least 2 characters).' });
    return null;
  }
  return name;
}

const handlers = {
  hello(ws, data) {
    if (!isValidToken(data.token)) return;
    ws.token = data.token;
    const room = rooms.get(tokenToRoom.get(ws.token));
    const seat = room ? room.seats.findIndex((s) => isHuman(s) && s.token === ws.token) : -1;
    if (!room || seat === -1) {
      tokenToRoom.delete(ws.token);
      send(ws, { type: 'no_room' });
      return;
    }
    reattach(ws, room, seat);
  },

  create_room(ws, data) {
    const name = requireName(ws, data.playerName);
    if (!name) return;
    leaveRoom(ws);
    const room = {
      code: generateRoomCode(),
      roomName: cleanText(data.roomName, 24) || 'Ludo Party',
      hostId: null,
      started: false,
      seats: [newHumanSeat(ws, name), null, null, null],
      rules: sanitizeRules(data.rules),
      game: null,
      emptyTimer: null,
    };
    room.hostId = room.seats[0].id;
    rooms.set(room.code, room);
    tokenToRoom.set(ws.token, room.code);
    ws.roomCode = room.code;
    sendRoom(room, room.seats[0], 0, 'room_joined');
  },

  join_room(ws, data) {
    const query = cleanText(data.roomCode, 24);
    let room = rooms.get(query.toUpperCase());
    if (!room) {
      for (const r of rooms.values()) {
        if (r.roomName.toLowerCase() === query.toLowerCase()) {
          room = r;
          break;
        }
      }
    }
    if (!room) {
      send(ws, { type: 'room_error', message: `Room "${query}" was not found. Check the 6-character code.` });
      return;
    }
    const mine = room.seats.findIndex((s) => isHuman(s) && s.token === ws.token);
    if (mine !== -1) {
      reattach(ws, room, mine);
      return;
    }
    const name = requireName(ws, data.playerName);
    if (!name) return;
    leaveRoom(ws);

    let seat = room.started ? -1 : SEAT_ORDER.find((i) => room.seats[i] === null) ?? -1;
    if (seat === -1) {
      seat = room.seats.findIndex(
        (s, i) => s && s.isBot && !isHuman(s) && (!gameRunning(room) || room.game.engine.players[i].active)
      );
    }
    if (seat === -1) {
      send(ws, { type: 'room_error', message: `Room "${room.roomName}" is full.` });
      return;
    }

    room.seats[seat] = newHumanSeat(ws, name);
    tokenToRoom.set(ws.token, room.code);
    ws.roomCode = room.code;
    maintainRoom(room);
    sendRoom(room, room.seats[seat], seat, 'room_joined');
    if (room.started && room.game) {
      if (gameRunning(room)) room.game.setBot(seat, false, name);
      room.game.sendView(seat);
    }
    // Everyone else hears a "player joined" chime.
    broadcast(room, { type: 'player_joined', name, seat }, seat);
    broadcastRoom(room);
  },

  leave_room(ws) {
    leaveRoom(ws);
  },

  toggle_bot(ws, data, room, seatIdx) {
    if (room.seats[seatIdx].id !== room.hostId || gameRunning(room)) return;
    const seat = Number(data.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat > 3 || seat === seatIdx) return;
    const s = room.seats[seat];
    if (s === null) {
      room.seats[seat] = { id: newId(), token: null, name: BOT_NAMES[seat], isBot: true, away: false, ws: null };
    } else if (s.isBot && !isHuman(s)) {
      room.seats[seat] = null;
    }
    broadcastRoom(room);
  },

  // Host only, between matches: easier-start house rules.
  set_rules(ws, data, room, seatIdx) {
    if (room.seats[seatIdx].id !== room.hostId || gameRunning(room)) return;
    room.rules = sanitizeRules({ ...room.rules, ...data.rules });
    broadcastRoom(room);
  },

  start_match(ws, data, room, seatIdx) {
    if (room.seats[seatIdx].id !== room.hostId || gameRunning(room)) return;
    room.seats.forEach((s, i) => isHuman(s) && s.isBot && vacateSeat(room, i));
    if (room.seats.filter(Boolean).length < 2) {
      send(ws, { type: 'room_error', message: 'At least 2 players are needed. Wait for a friend or add a bot.' });
      return;
    }
    startGame(room);
  },

  // After a match everyone taps Play Again; the next match starts when all are ready.
  rematch_vote(ws, data, room, seatIdx) {
    if (!room.started || gameRunning(room)) return;
    room.seats[seatIdx].ready = true;
    const humans = room.seats.filter(isConnected);
    if (humans.every((s) => s.ready)) {
      room.seats.forEach((s, i) => isHuman(s) && s.isBot && vacateSeat(room, i));
      if (room.seats.filter(Boolean).length >= 2) startGame(room);
    }
    broadcastRoom(room);
  },

  action(ws, data, room, seatIdx) {
    if (!room.game) return;
    const type = cleanText(data.action?.type, 8);
    const action = type === 'move' ? { type, pawn: Number(data.action?.pawn) } : { type };
    room.game.handle(seatIdx, action); // seat from the server, never the client
  },

  emote(ws, data, room, seatIdx) {
    const now = Date.now();
    if (now - (ws.lastEmoteAt || 0) < 600) return;
    ws.lastEmoteAt = now;
    broadcast(room, { type: 'room_emote', seat: seatIdx, playerName: room.seats[seatIdx].name, emote: cleanText(data.emote, 8) });
  },
};

const NO_ROOM_NEEDED = new Set(['hello', 'create_room', 'join_room', 'leave_room']);

wss.on('connection', (ws) => {
  ws.token = `anon_${crypto.randomBytes(12).toString('hex')}`;
  ws.roomCode = null;
  ws.msgWindowStart = Date.now();
  ws.msgCount = 0;
  send(ws, { type: 'welcome', onlineCount: wss.clients.size });
  broadcastOnlineCount();

  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - ws.msgWindowStart > 5000) {
      ws.msgWindowStart = now;
      ws.msgCount = 0;
    }
    if (++ws.msgCount > 40) return; // simple rate limit
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const handler = handlers[data?.type];
    if (!handler) return;
    try {
      if (NO_ROOM_NEEDED.has(data.type)) return handler(ws, data);
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (!room) return;
      const seatIdx = seatOf(room, ws);
      if (seatIdx === -1) return;
      handler(ws, data, room, seatIdx);
    } catch (err) {
      console.error('Handler error', data.type, err);
    }
  });

  ws.on('close', () => {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (room) {
      const seat = room.seats.findIndex((s) => isHuman(s) && s.ws === ws);
      if (seat !== -1) markAway(room, seat);
    }
    broadcastOnlineCount();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Ludo 3D server running at http://localhost:${PORT}`);
});
