import test from 'node:test';
import assert from 'node:assert/strict';
import { LudoEngine, FINISH } from '../shared/ludoEngine.js';
import { SAFE_INDICES, getPawnGridPos } from '../shared/boardData.js';

const seats = (n = 4) => [0, 1, 2, 3].map((i) => ({ name: `P${i}`, isBot: true, active: i < n }));

function playOut(n, rng) {
  const e = new LudoEngine({ players: seats(n), rng });
  e.start();
  for (let i = 0; i < 20000 && !e.gameOver; i++) {
    const res = e.act(e.current, e.autoAction());
    assert.ok(res.ok, res.error);
    for (const p of e.players) {
      for (const pr of p.pawns) assert.ok(pr >= -1 && pr <= FINISH, `pawn out of range: ${pr}`);
      assert.equal(p.finished, p.pawns.filter((x) => x === FINISH).length);
    }
  }
  return e;
}

test('bot games always finish with a winner who has all 4 home', () => {
  for (const n of [2, 3, 4]) {
    for (let k = 0; k < 60; k++) {
      const e = playOut(n);
      assert.ok(e.gameOver);
      assert.equal(e.players[e.winner].finished, 4);
      assert.equal(e.standings[0].seat, e.winner);
    }
  }
});

test('out-of-turn and illegal actions are rejected', () => {
  const e = new LudoEngine({ players: seats(4), rng: () => 0.1 }); // always rolls 1
  e.start();
  assert.equal(e.act(1, { type: 'roll' }).error, 'not_your_turn');
  assert.equal(e.act(0, { type: 'move', pawn: 0 }).error, 'roll_first');
  const r = e.act(0, { type: 'roll' }); // a 1 with every pawn in the yard: no moves
  assert.ok(r.events.some((ev) => ev.type === 'no_moves'));
  assert.equal(e.current, 1);
});

test('a 6 brings a pawn out and gives a bonus roll', () => {
  const e = new LudoEngine({ players: seats(2), rng: () => 0.99 }); // always 6
  e.start();
  const r = e.act(0, { type: 'roll' });
  assert.ok(r.events.some((ev) => ev.type === 'choose'));
  const m = e.act(0, { type: 'move', pawn: 2 });
  assert.equal(e.players[0].pawns[2], 0);
  assert.ok(m.events.some((ev) => ev.type === 'bonus' && ev.reason === 'six'));
  assert.equal(e.current, 0);
});

test('three sixes in a row forfeits the turn', () => {
  const e = new LudoEngine({ players: seats(2), rng: () => 0.99 });
  e.start();
  e.players[0].pawns = [10, 20, 30, 40];
  let events = [];
  for (let i = 0; i < 3; i++) {
    const r = e.act(0, { type: 'roll' });
    events = r.events;
    if (e.phase === 'choose') e.act(0, { type: 'move', pawn: e.movable[0] });
  }
  assert.ok(events.some((ev) => ev.type === 'three_sixes'));
  assert.equal(e.current, 1);
});

test('landing on an opponent captures it (not on safe squares)', () => {
  const rolls = [3 / 6 + 0.01]; // a 4
  const e = new LudoEngine({ players: seats(2), rng: () => rolls[0] });
  e.start();
  // Red pawn at progress 2 -> lands on progress 6 (track index 6, not safe).
  e.players[0].pawns = [2, -1, -1, -1];
  const target = getPawnGridPos(0, 0, 6).outerIdx;
  assert.ok(!SAFE_INDICES.has(target));
  // Put a green pawn on the same track square: green starts at index 13.
  const greenProg = (target - 13 + 52) % 52;
  e.players[1].pawns = [greenProg, -1, -1, -1];
  const r = e.act(0, { type: 'roll' });
  assert.ok(r.events.some((ev) => ev.type === 'capture' && ev.victim === 1));
  assert.equal(e.players[1].pawns[0], -1);
  assert.equal(e.current, 0, 'capture gives a bonus roll');
});

test('exact roll needed to reach home', () => {
  const e = new LudoEngine({ players: seats(2), rng: () => 0.99 }); // 6
  e.start();
  e.players[0].pawns = [52, 56, 56, 56];
  e.players[0].finished = 3;
  assert.deepEqual(e.movablePawns(0, 6), []);
  assert.deepEqual(e.movablePawns(0, 4), [0]);
});
