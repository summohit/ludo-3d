// Multiplayer check against a running server:
//   TURN_MS=3000 RECONNECT_GRACE_MS=1500 PORT=4196 node server.js
//   node tests/multiplayer.check.mjs 4196
import WebSocket from 'ws';
import crypto from 'node:crypto';
const PORT = process.argv[2] || 4196;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const c = { ws, name, room: null, seat: null, view: null, msgs: [], joins: [], errors: [], playing: false };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m.type);
    if (m.room) { c.room = m.room; c.seat = m.seat; }
    if (m.type === 'player_joined') c.joins.push(m.name);
    if (m.type === 'room_error' || m.type === 'action_error') c.errors.push(m.message || m.error);
    if (m.type === 'game_update') {
      c.view = m.view;
      const v = m.view;
      if (c.playing && !v.gameOver && v.current === c.seat && m.events.some((e) => ['turn', 'bonus', 'start', 'choose', 'no_moves', 'three_sixes'].includes(e.type) || true)) {
        const action = v.phase === 'roll' ? { type: 'roll' } : { type: 'move', pawn: v.movable[0] };
        setTimeout(() => ws.send(JSON.stringify({ type: 'action', action })), 30);
      }
    }
  });
  return new Promise((res) => ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', token: crypto.randomBytes(16).toString('hex') }));
    res(c);
  }));
}
const send = (c, m) => c.ws.send(JSON.stringify(m));

const a = await client('Mohit');
const b = await client('Pritish');
const d = await client('Riya');
const nameless = await client('');

send(a, { type: 'create_room', roomName: 'friday', playerName: 'Mohit' });
await sleep(150);
send(nameless, { type: 'join_room', roomCode: a.room.code, playerName: '   ' });
await sleep(150);
check('joining without a name is refused', nameless.errors.some((e) => /name/i.test(e)) && !nameless.room);

send(b, { type: 'join_room', roomCode: a.room.code, playerName: 'Pritish' });
await sleep(150);
send(d, { type: 'join_room', roomCode: a.room.code, playerName: 'Riya' });
await sleep(150);
check('host hears both joins', a.joins.includes('Pritish') && a.joins.includes('Riya'));
check('Pritish hears Riya join', b.joins.includes('Riya'));
check('joiner does not hear their own join', !b.joins.includes('Pritish'));

const free = [0, 1, 2, 3].find((s) => !a.room.players.some((p) => p.seat === s));
send(a, { type: 'toggle_bot', seat: free });
await sleep(150);
send(a, { type: 'start_match' });
await sleep(400);

const roster = (c) => JSON.stringify(c.view.players.map((p) => [p.seat, p.active, p.name, p.isBot]));
check('3 people + 1 bot: all four seats active', a.view.players.every((p) => p.active));
check('everyone sees the same seats and names', roster(a) === roster(b) && roster(b) === roster(d));
console.log('   seats:', a.view.players.map((p) => `${p.seat}:${p.name}${p.isBot ? '(bot)' : ''}`).join(', '));

// Cheating attempts: rolling out of turn, or claiming another seat
const cur = a.view.current;
const other = [a, b, d].find((c) => c.seat !== cur);
other.errors = [];
send(other, { type: 'action', seat: cur, action: { type: 'roll' } });
await sleep(150);
check('cannot roll for another seat', other.errors.includes('not_your_turn') && a.view.dice === 0);

// Play for a while: turns must keep moving between all four seats (a full match takes ~10 min with animations)
[a, b, d].forEach((c) => (c.playing = true));
const kick = [a, b, d].find((c) => c.seat === a.view.current);
if (kick) send(kick, { type: 'action', action: { type: 'roll' } });
const seenTurns = new Set();
for (let i = 0; i < 450; i++) {
  seenTurns.add(a.view.current);
  await sleep(100);
}
const pawnsOut = a.view.players.reduce((n, p) => n + p.pawns.filter((x) => x >= 0).length, 0);
check('turns rotate through all four seats (incl. the bot)', seenTurns.size === 4);
check('everyone still sees the same board', JSON.stringify(a.view.players.map((p) => p.pawns)) === JSON.stringify(d.view.players.map((p) => p.pawns)));
console.log('   pawns out of yards after 45s:', pawnsOut);

[a, b, d, nameless].forEach((c) => c.ws.close());
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
