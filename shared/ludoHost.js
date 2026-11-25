// Runs one Ludo match: owns the engine, plays bot turns, runs the turn timer,
// and sends everyone the new state plus the events to animate.
// Used by the server for rooms and by the browser for solo games.
import { LudoEngine, animationMs } from './ludoEngine.js';

export class LudoHost {
  /**
   * @param {object} opts
   * @param {{name:string,isBot:boolean,active:boolean}[]} opts.players
   * @param {(seat:number, payload:object) => void} opts.send
   * @param {number} [opts.turnMs] time a human gets per step (roll or pick); null = no timer
   * @param {number} [opts.botThinkMs]
   */
  constructor({ players, send, turnMs = 60_000, botThinkMs = 650, rng }) {
    this.engine = new LudoEngine({ players, rng });
    this.send = send;
    this.turnMs = turnMs;
    this.botThinkMs = botThinkMs;
    this.timer = null;
    this.turnEndsAt = null;
    this.stopped = false;
  }

  start() {
    this.publish(this.engine.start());
  }

  /** The seat must come from the server's own records, never from the client. */
  handle(seat, action) {
    if (this.stopped) return { ok: false, error: 'stopped' };
    const res = this.engine.act(seat, action);
    if (!res.ok) {
      this.send(seat, { type: 'action_error', error: res.error });
      return res;
    }
    this.publish(res.events);
    return res;
  }

  publish(events) {
    if (this.stopped) return;
    const busyMs = animationMs(events);
    this.schedule(busyMs);
    const view = this.view();
    for (let seat = 0; seat < 4; seat++) this.send(seat, { type: 'game_update', view, events });
  }

  view() {
    return {
      ...this.engine.view(),
      turnMsLeft: this.turnEndsAt ? Math.max(0, this.turnEndsAt - Date.now()) : null,
      turnMs: this.turnMs,
    };
  }

  sendView(seat) {
    this.send(seat, { type: 'game_update', view: this.view(), events: [] });
  }

  /** After the clients finish animating: a bot plays, or a human's clock starts. */
  schedule(busyMs) {
    clearTimeout(this.timer);
    this.timer = null;
    this.turnEndsAt = null;
    const e = this.engine;
    if (this.stopped || e.gameOver) return;
    const seat = e.current;
    const p = e.players[seat];

    if (p.isBot) {
      this.timer = setTimeout(() => this.autoPlay(seat), busyMs + this.botThinkMs);
      return;
    }
    if (this.turnMs) {
      const wait = busyMs + this.turnMs;
      this.turnEndsAt = Date.now() + wait;
      this.timer = setTimeout(() => {
        if (this.stopped || e.gameOver || e.current !== seat) return;
        this.publish([{ type: 'timeout', seat }].concat(this.engine.act(seat, e.autoAction()).events));
      }, wait);
    }
  }

  autoPlay(seat) {
    const e = this.engine;
    if (this.stopped || e.gameOver || e.current !== seat) return;
    this.handle(seat, e.autoAction());
  }

  /** Player left or dropped for too long: a bot plays the seat (or a human takes it back). */
  setBot(seat, isBot, name) {
    this.engine.setBot(seat, isBot, name);
    this.publish([{ type: 'roster', seat }]);
  }

  setAway(seat, away) {
    const p = this.engine.players[seat];
    if (!p || p.away === away) return;
    p.away = away;
    // Don't restart anyone's clock just because someone dropped or came back.
    const view = this.view();
    const events = [{ type: away ? 'player_away' : 'player_back', seat }];
    for (let s = 0; s < 4; s++) this.send(s, { type: 'game_update', view, events });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
