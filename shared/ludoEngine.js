// Pure Ludo rules engine: no DOM, no Three.js, no timers.
// Runs on the server for rooms (so dice can't be rigged) and in the browser for solo games.
// Every action returns a list of events that clients animate.
import { SAFE_INDICES, getPawnGridPos } from './boardData.js';

export const FINISH = 56; // progress: -1 yard, 0..50 track, 51..55 home column, 56 home
export const LUCKY_SIX_AFTER = 8; // rolls without a 6 before the next roll is a guaranteed 6

/** House rules that make the start easier. Both on unless the room host turns them off. */
export const DEFAULT_RULES = { startOn1: true, luckySix: true };

export function sanitizeRules(input = {}) {
  const r = { ...DEFAULT_RULES };
  for (const k of Object.keys(DEFAULT_RULES)) if (typeof input?.[k] === 'boolean') r[k] = input[k];
  return r;
}

export class LudoEngine {
  /**
   * @param {object} opts
   * @param {{name:string,isBot:boolean,active:boolean}[]} opts.players exactly 4 seats
   * @param {() => number} [opts.rng]
   */
  constructor({ players, rng = Math.random, rules }) {
    this.rng = rng;
    this.rules = sanitizeRules(rules);
    this.players = players.map((p, seat) => ({
      seat,
      name: String(p.name || `Player ${seat + 1}`),
      isBot: Boolean(p.isBot),
      active: Boolean(p.active),
      away: false,
      pawns: [-1, -1, -1, -1],
      finished: 0,
      captures: 0,
      rollsSinceSix: 0,
    }));
    this.current = 0;
    this.phase = 'roll'; // 'roll' | 'choose'
    this.dice = 0;
    this.sixes = 0;
    this.movable = [];
    this.started = false;
    this.gameOver = false;
    this.winner = null;
    this.standings = null;
  }

  activeSeats() {
    return this.players.filter((p) => p.active).map((p) => p.seat);
  }

  start() {
    if (this.activeSeats().length < 2) throw new Error('Need at least 2 players');
    this.started = true;
    this.current = this.activeSeats()[0];
    return [{ type: 'start' }, { type: 'turn', seat: this.current }];
  }

  movablePawns(seat, roll) {
    const p = this.players[seat];
    const out = [];
    p.pawns.forEach((prog, idx) => {
      const canLeaveYard = roll === 6 || (this.rules.startOn1 && roll === 1);
      if (prog === -1 ? canLeaveYard : prog >= 0 && prog + roll <= FINISH) out.push(idx);
    });
    return out;
  }

  /** Opponent pawns standing on this seat's landing square (only on the shared track). */
  pawnsHitBy(seat, pawn, progress) {
    if (progress < 0 || progress > 50) return [];
    const landing = getPawnGridPos(seat, pawn, progress);
    if (SAFE_INDICES.has(landing.outerIdx)) return [];
    const hits = [];
    for (const opp of this.players) {
      if (opp.seat === seat || !opp.active) continue;
      opp.pawns.forEach((op, oi) => {
        if (op >= 0 && op <= 50 && getPawnGridPos(opp.seat, oi, op).outerIdx === landing.outerIdx) {
          hits.push({ seat: opp.seat, pawn: oi, from: op });
        }
      });
    }
    return hits;
  }

  /** Main entry point. Returns { ok, error?, events }. */
  act(seat, action) {
    const events = [];
    if (!this.started || this.gameOver) return { ok: false, error: 'game_not_running', events };
    if (seat !== this.current) return { ok: false, error: 'not_your_turn', events };

    if (action?.type === 'roll') {
      if (this.phase !== 'roll') return { ok: false, error: 'pick_a_pawn', events };
      this.roll(seat, events);
      return { ok: true, events };
    }
    if (action?.type === 'move') {
      if (this.phase !== 'choose') return { ok: false, error: 'roll_first', events };
      const pawn = Number(action.pawn);
      if (!this.movable.includes(pawn)) return { ok: false, error: 'illegal_pawn', events };
      this.move(seat, pawn, events);
      return { ok: true, events };
    }
    return { ok: false, error: 'unknown_action', events };
  }

  roll(seat, events) {
    const p = this.players[seat];
    // Lucky 6: after a long run without a 6, the next roll is a 6.
    const lucky = this.rules.luckySix && p.rollsSinceSix >= LUCKY_SIX_AFTER;
    const roll = lucky ? 6 : 1 + Math.floor(this.rng() * 6);
    p.rollsSinceSix = roll === 6 ? 0 : p.rollsSinceSix + 1;
    this.dice = roll;
    events.push({ type: 'roll', seat, roll, lucky });

    if (roll === 6) {
      this.sixes += 1;
      if (this.sixes >= 3) {
        events.push({ type: 'three_sixes', seat });
        this.advance(events);
        return;
      }
    } else {
      this.sixes = 0;
    }

    const movable = this.movablePawns(seat, roll);
    if (movable.length === 0) {
      events.push({ type: 'no_moves', seat, roll });
      this.advance(events);
      return;
    }

    this.phase = 'choose';
    this.movable = movable;
    events.push({ type: 'choose', seat, roll, movable });
    // Only one legal move: play it straight away.
    if (movable.length === 1) this.move(seat, movable[0], events);
  }

  move(seat, pawn, events) {
    const p = this.players[seat];
    const from = p.pawns[pawn];
    const to = from === -1 ? 0 : from + this.dice;
    p.pawns[pawn] = to;
    this.movable = [];
    events.push({ type: 'move', seat, pawn, from, to });

    let bonus = this.dice === 6 ? 'six' : null;

    if (to === FINISH) {
      p.finished += 1;
      bonus = 'home';
      events.push({ type: 'home', seat, pawn });
    } else {
      const hits = this.pawnsHitBy(seat, pawn, to);
      for (const h of hits) {
        this.players[h.seat].pawns[h.pawn] = -1;
        p.captures += 1;
        bonus = 'capture';
        events.push({ type: 'capture', seat, victim: h.seat, pawn: h.pawn, from: h.from });
      }
    }

    if (p.finished >= 4) {
      this.finish(seat, events);
      return;
    }

    if (bonus) {
      this.phase = 'roll';
      events.push({ type: 'bonus', seat, reason: bonus });
    } else {
      this.advance(events);
    }
  }

  advance(events) {
    if (this.gameOver) return;
    let next = this.current;
    for (let guard = 0; guard < 8; guard++) {
      next = (next + 1) % 4;
      const p = this.players[next];
      if (p.active && p.finished < 4) break;
    }
    this.current = next;
    this.phase = 'roll';
    this.sixes = 0;
    this.movable = [];
    events.push({ type: 'turn', seat: next });
  }

  finish(seat, events) {
    this.gameOver = true;
    this.winner = seat;
    this.standings = this.players
      .filter((p) => p.active)
      .map((p) => ({ seat: p.seat, name: p.name, homeCount: p.finished, captures: p.captures, isWinner: p.seat === seat }))
      .sort((a, b) => b.isWinner - a.isWinner || b.homeCount - a.homeCount || b.captures - a.captures);
    events.push({ type: 'win', seat, standings: this.standings });
  }

  /** Bot choice (also used when a human's time runs out). */
  bestPawn(seat) {
    const p = this.players[seat];
    let best = this.movable[0];
    let bestScore = -Infinity;
    for (const idx of this.movable) {
      const cur = p.pawns[idx];
      const next = cur === -1 ? 0 : cur + this.dice;
      let score;
      if (cur === -1) score = this.dice === 6 ? 85 : 75; // get a pawn out
      else if (next === FINISH) score = 120;
      else if (next >= 51) score = 70 + next; // safe in the home column
      else if (this.pawnsHitBy(seat, idx, next).length) score = 110;
      else if (SAFE_INDICES.has(getPawnGridPos(seat, idx, next).outerIdx)) score = 60;
      else score = 20 + next * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = idx;
      }
    }
    return best;
  }

  /** What a bot (or the turn timer) does next for the current player. */
  autoAction() {
    if (this.phase === 'roll') return { type: 'roll' };
    return { type: 'move', pawn: this.bestPawn(this.current) };
  }

  setBot(seat, isBot, name) {
    const p = this.players[seat];
    if (!p) return;
    p.isBot = isBot;
    if (name) p.name = name;
  }

  /** Ludo has no hidden information, so every seat gets the same view. */
  view() {
    return {
      started: this.started,
      current: this.current,
      phase: this.phase,
      dice: this.dice,
      movable: [...this.movable],
      gameOver: this.gameOver,
      winner: this.winner,
      standings: this.standings,
      rules: { ...this.rules },
      players: this.players.map((p) => ({
        seat: p.seat,
        name: p.name,
        isBot: p.isBot,
        active: p.active,
        away: p.away,
        pawns: [...p.pawns],
        finished: p.finished,
        captures: p.captures,
      })),
    };
  }
}

/** Rough time the clients need to animate these events (so bots wait for them). */
export function animationMs(events) {
  let ms = 0;
  for (const e of events) {
    if (e.type === 'roll') ms += 1050;
    else if (e.type === 'move') ms += 260 + 200 * (e.from === -1 ? 1 : e.to - e.from);
    else if (e.type === 'capture') ms += 900 + Math.ceil(e.from / 2) * 70;
    else if (e.type === 'home') ms += 500;
    else if (e.type === 'three_sixes' || e.type === 'no_moves') ms += 750;
  }
  return ms;
}
