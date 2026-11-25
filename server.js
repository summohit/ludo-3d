const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4174;
const ROOT_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);
  if (pathname === '/') pathname = '/index.html';

  const safePath = path.normalize(path.join(ROOT_DIR, pathname));
  if (!safePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(safePath).pipe(res);
  });
});

const rooms = new Map();
const BOT_NAMES = ['Red Bot', 'Nova (Bot)', 'Apex (Bot)', 'Blaze (Bot)'];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function getPublicRoomInfo(room) {
  return {
    code: room.code,
    roomName: room.roomName,
    hostId: room.hostId,
    started: room.started,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      isBot: Boolean(p.isBot),
      connected: Boolean(p.isBot || (p.ws && p.ws.readyState === 1)),
    })),
  };
}

function broadcastToRoom(room, payload, excludeWs = null) {
  const msg = JSON.stringify(payload);
  room.players.forEach((p) => {
    if (p.ws && p.ws !== excludeWs && p.ws.readyState === 1) {
      p.ws.send(msg);
    }
  });
}

const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastOnlineCount() {
  const count = wss.clients.size;
  const msg = JSON.stringify({ type: 'online_count', count });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  ws.clientId = `l_${Math.random().toString(36).slice(2, 10)}`;
  ws.roomCode = null;

  ws.send(
    JSON.stringify({
      type: 'welcome',
      clientId: ws.clientId,
      onlineCount: wss.clients.size,
    })
  );
  broadcastOnlineCount();

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    if (data.type === 'create_room') {
      const code = generateRoomCode();
      const roomName = (data.roomName || 'ludo-arena').trim().slice(0, 24);
      const playerName = (data.playerName || 'Admin').trim().slice(0, 18);
      const room = {
        code,
        roomName,
        hostId: ws.clientId,
        started: false,
        players: [
          {
            id: ws.clientId,
            name: playerName,
            seat: 0,
            isBot: false,
            ws,
          },
        ],
        lastState: null,
      };
      rooms.set(code, room);
      ws.roomCode = code;

      ws.send(
        JSON.stringify({
          type: 'room_joined',
          clientId: ws.clientId,
          seat: 0,
          room: getPublicRoomInfo(room),
        })
      );
      return;
    }

    if (data.type === 'join_room') {
      const query = (data.roomCode || '').trim();
      let room = rooms.get(query.toUpperCase());
      if (!room) {
        for (const candidate of rooms.values()) {
          if (candidate.roomName.toLowerCase() === query.toLowerCase()) {
            room = candidate;
            break;
          }
        }
      }

      if (!room) {
        ws.send(
          JSON.stringify({
            type: 'room_error',
            message: `Room "${query}" was not found. Check the 6-character code or Room Name.`,
          })
        );
        return;
      }

      let existing = room.players.find((p) => p.id === ws.clientId);
      if (!existing) {
        if (room.players.length >= 4) {
          const botIdx = room.players.findIndex((p) => p.isBot);
          if (botIdx === -1) {
            ws.send(
              JSON.stringify({
                type: 'room_error',
                message: `Room "${room.roomName}" (${room.code}) is full (4/4).`,
              })
            );
            return;
          }
          const seat = room.players[botIdx].seat;
          existing = {
            id: ws.clientId,
            name: (data.playerName || `Player ${seat + 1}`).trim().slice(0, 18),
            seat,
            isBot: false,
            ws,
          };
          room.players[botIdx] = existing;
        } else {
          const taken = new Set(room.players.map((p) => p.seat));
          // Prefer opposite corner seat (seat 2 = Yellow) for 2nd player in Ludo!
          const seatPriority = [0, 2, 1, 3];
          const assignedSeat = seatPriority.find((s) => !taken.has(s)) ?? 1;
          existing = {
            id: ws.clientId,
            name: (data.playerName || `Player ${assignedSeat + 1}`).trim().slice(0, 18),
            seat: assignedSeat,
            isBot: false,
            ws,
          };
          room.players.push(existing);
        }
      } else {
        existing.ws = ws;
      }

      ws.roomCode = room.code;
      ws.send(
        JSON.stringify({
          type: 'room_joined',
          clientId: ws.clientId,
          seat: existing.seat,
          room: getPublicRoomInfo(room),
          lastState: room.lastState,
        })
      );
      broadcastToRoom(room, {
        type: 'room_updated',
        room: getPublicRoomInfo(room),
      });
      return;
    }

    if (data.type === 'leave_room') {
      handleLeave(ws);
      return;
    }

    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;

    if (data.type === 'admin_toggle_seat_bot' && room.hostId === ws.clientId) {
      const targetSeat = Number(data.seat);
      if (targetSeat < 1 || targetSeat > 3) return;
      const idx = room.players.findIndex((p) => p.seat === targetSeat);
      if (idx !== -1) {
        if (room.players[idx].isBot) room.players.splice(idx, 1);
      } else {
        room.players.push({
          id: `bot_seat_${targetSeat}`,
          name: BOT_NAMES[targetSeat] || `Bot ${targetSeat}`,
          seat: targetSeat,
          isBot: true,
          ws: null,
        });
      }
      broadcastToRoom(room, {
        type: 'room_updated',
        room: getPublicRoomInfo(room),
      });
      return;
    }

    if (data.type === 'host_start_match' && room.hostId === ws.clientId) {
      if (room.players.length < 2) {
        ws.send(
          JSON.stringify({
            type: 'room_error',
            message:
              'Need at least 2 players to start! Wait for a friend to join or click "+ Add AI Bot" on a vacant seat.',
          })
        );
        return;
      }
      room.started = true;
      broadcastToRoom(room, {
        type: 'match_started',
        room: getPublicRoomInfo(room),
      });
      return;
    }

    if (data.type === 'game_state_sync' && room.hostId === ws.clientId) {
      room.lastState = data.state;
      broadcastToRoom(
        room,
        {
          type: 'game_state_sync',
          state: data.state,
          event: data.event || null,
        },
        ws
      );
      return;
    }

    if (data.type === 'remote_player_action') {
      const host = room.players.find((p) => p.id === room.hostId);
      if (host && host.ws && host.ws.readyState === 1) {
        host.ws.send(
          JSON.stringify({
            type: 'remote_player_action',
            seat: data.seat,
            action: data.action,
          })
        );
      }
      return;
    }

    if (data.type === 'room_emote') {
      broadcastToRoom(room, {
        type: 'room_emote',
        seat: data.seat,
        playerName: data.playerName,
        emote: data.emote,
      });
    }
  });

  ws.on('close', () => {
    handleLeave(ws);
    broadcastOnlineCount();
  });
});

function handleLeave(ws) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  ws.roomCode = null;
  if (!room) return;

  const idx = room.players.findIndex((p) => p.id === ws.clientId);
  if (idx !== -1) room.players.splice(idx, 1);

  const remainingHumans = room.players.filter((p) => !p.isBot);
  if (remainingHumans.length === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === ws.clientId) {
    room.hostId = remainingHumans[0].id;
  }
  broadcastToRoom(room, {
    type: 'room_updated',
    room: getPublicRoomInfo(room),
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LUDO 3D Neon Arena Server running at http://localhost:${PORT}`);
});
