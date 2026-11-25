import test from 'node:test';
import assert from 'node:assert/strict';
import { LudoEngine, LUCKY_SIX_AFTER, sanitizeRules } from '../shared/ludoEngine.js';

const seats = () => [0, 1, 2, 3].map((i) => ({ name: `P${i}`, isBot: true, active: i < 2 }));
const fixed = (n) => () => (n - 1) / 6 + 0.01; // rng that always rolls n

test('both easier-start rules are on by default', () => {
  assert.deepEqual(sanitizeRules({}), { startOn1: true, luckySix: true });
  assert.deepEqual(sanitizeRules({ startOn1: false, evil: 1 }), { startOn1: false, luckySix: true });
});

test('a 1 brings a pawn out when startOn1 is on, without a bonus roll', () => {
  const e = new LudoEngine({ players: seats(), rng: fixed(1) });
  e.start();
  const r = e.act(0, { type: 'roll' }); // 4 movable pawns -> choose
  assert.deepEqual(e.movable, [0, 1, 2, 3]);
  const m = e.act(0, { type: 'move', pawn: 0 });
  assert.equal(e.players[0].pawns[0], 0);
  assert.ok(!m.events.some((ev) => ev.type === 'bonus'), 'a 1 gives no bonus roll');
  assert.equal(e.current, 1);
  assert.ok(r.ok);
});

test('a 1 does nothing for yard pawns when startOn1 is off', () => {
  const e = new LudoEngine({ players: seats(), rng: fixed(1), rules: { startOn1: false } });
  e.start();
  const r = e.act(0, { type: 'roll' });
  assert.ok(r.events.some((ev) => ev.type === 'no_moves'));
});

test(`Lucky 6 arrives after ${LUCKY_SIX_AFTER} rolls without a 6`, () => {
  const e = new LudoEngine({ players: seats(), rng: fixed(2), rules: { startOn1: false } });
  e.start();
  const rollsOfSeat0 = [];
  for (let i = 0; i < 40 && rollsOfSeat0.length < LUCKY_SIX_AFTER + 1; i++) {
    const seat = e.current;
    const res = e.act(seat, e.autoAction());
    for (const ev of res.events) if (ev.type === 'roll' && ev.seat === 0) rollsOfSeat0.push(ev);
  }
  assert.deepEqual(rollsOfSeat0.slice(0, LUCKY_SIX_AFTER).map((r) => r.roll), Array(LUCKY_SIX_AFTER).fill(2));
  assert.equal(rollsOfSeat0[LUCKY_SIX_AFTER].roll, 6);
  assert.equal(rollsOfSeat0[LUCKY_SIX_AFTER].lucky, true);
});

test('Lucky 6 never triggers when the rule is off', () => {
  const e = new LudoEngine({ players: seats(), rng: fixed(2), rules: { luckySix: false } });
  e.start();
  for (let i = 0; i < 60; i++) {
    const res = e.act(e.current, e.autoAction());
    assert.ok(!res.events.some((ev) => ev.type === 'roll' && ev.roll === 6));
  }
});

test('full bot games still finish with the easier rules on', () => {
  for (let k = 0; k < 60; k++) {
    const e = new LudoEngine({ players: [0, 1, 2, 3].map((i) => ({ name: `P${i}`, isBot: true, active: true })) });
    e.start();
    for (let i = 0; i < 20000 && !e.gameOver; i++) assert.ok(e.act(e.current, e.autoAction()).ok);
    assert.ok(e.gameOver);
  }
});
