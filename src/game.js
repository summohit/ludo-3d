// Client-side Ludo: animates the state and events sent by the match host and
// turns the player's taps into actions. The rules (and the dice) run in
// shared/ludoEngine.js: on the server for rooms, in a local LudoHost for solo.
import * as THREE from 'three';
import { gsap } from 'gsap';
import { LUDO_COLORS, SAFE_INDICES, HOME_YARDS, gridToWorld, getPawnGridPos } from './boardData.js';
import { LudoHost } from '../shared/ludoHost.js';
import { sound } from './audio.js';

const SOLO_BOTS = ['', 'Nova (Bot)', 'Apex (Bot)', 'Blaze (Bot)'];
const ERROR_TEXT = {
  not_your_turn: 'Wait for your turn!',
  pick_a_pawn: 'Pick one of your glowing pawns first.',
  roll_first: 'Roll the dice first!',
  illegal_pawn: "That pawn can't move with this roll.",
};

export class Ludo3DGame {
  constructor(arena, ui) {
    this.arena = arena;
    this.ui = ui;
    this.network = null;
    this.localHost = null; // LudoHost for solo games

    this.localSeat = 0;
    this.localProfileName = '';
    this.waitingForAdminStart = false;
    this.cameraPresetIndex = 0;

    this.view = null; // last state from the host
    this.queue = Promise.resolve(); // updates are animated one after another
    this.animating = false;
    this.awaiting = false; // sent an action, waiting for the reply
    this.turnEndsAt = null;
    this.timerTick = null;

    this.players = this.rosterFromView(null);
  }

  // --- State shown to main.js -------------------------------------------------
  get gameOver() {
    return !this.view || this.view.gameOver;
  }
  get currentPlayer() {
    return this.view ? this.view.current : 0;
  }
  get phase() {
    return this.view ? this.view.phase : 'roll';
  }
  get isBusy() {
    return this.animating || this.awaiting || !this.view || this.view.gameOver;
  }

  attachNetwork(net) {
    this.network = net;
  }

  inRoom() {
    return Boolean(this.network && this.network.isInRoom());
  }

  setLocalProfileName(name) {
    this.localProfileName = name || '';
  }

  rosterFromView(view, room = null) {
    return [0, 1, 2, 3].map((seat) => {
      const vp = view?.players[seat];
      const occ = room?.players?.find((p) => p.seat === seat);
      const active = view ? vp.active : room ? Boolean(occ) : true;
      const rawName = view ? vp.name : occ ? occ.name : seat === 0 ? this.localProfileName || 'You' : SOLO_BOTS[seat];
      return {
        id: seat,
        color: LUDO_COLORS[seat],
        rawName,
        name: !active ? 'VACANT SEAT' : seat === this.localSeat ? `${rawName} (You)` : rawName,
        isBot: view ? vp.isBot : Boolean(occ?.isBot),
        activeSeat: active,
        isVacant: !active,
        away: Boolean(vp?.away || occ?.away),
        pawns: vp ? [...vp.pawns] : [-1, -1, -1, -1],
        finishedCount: vp ? vp.finished : 0,
        captures: vp ? vp.captures : 0,
      };
    });
  }

  // --- Lobby ---------------------------------------------------------------------
  configureRosterFromRoom(room, localSeat) {
    this.localSeat = localSeat;
    if (this.view) {
      this.players = this.rosterFromView(this.view);
    } else {
      this.players = this.rosterFromView(null, room);
      this.players.forEach((p) => this.arena.setSeatVisibility(p.id, p.activeSeat));
    }
    this.syncHUD();
  }

  enterRoomWaitingState(room, localSeat) {
    this.stopLocalGame();
    this.stopTurnTimer();
    this.waitingForAdminStart = true;
    this.view = null;
    this.configureRosterFromRoom(room, localSeat);
    this.resetAllPawnsVisual();
    this.arena.setMovablePawns(-1, []);
    this.arena.clearLandingPreviews();
  }

  resetAllPawnsVisual() {
    for (let seat = 0; seat < 4; seat++) {
      for (let i = 0; i < 4; i++) {
        const pawn = this.arena.pawns[seat][i];
        const [r, c] = HOME_YARDS[seat][i];
        const pos = gridToWorld(r, c);
        gsap.killTweensOf(pawn.position);
        pawn.position.set(pos.x, 0.14, pos.z);
        pawn.rotation.y = 0;
        pawn.scale.set(1, 1, 1);
      }
    }
  }

  // --- Starting matches ------------------------------------------------------------
  stopLocalGame() {
    if (this.localHost) {
      this.localHost.stop();
      this.localHost = null;
    }
  }

  /** Solo: new local match. In a room: vote to play again (or the host starts the first match). */
  startNewMatch() {
    if (this.inRoom()) {
      if (this.network.room?.started) {
        this.network.voteRematch();
        this.ui.showBanner('Ready! Waiting for the others to tap Play Again...', 'yellow');
      } else if (this.network.isHost()) {
        this.network.requestStartMatch();
      }
      return;
    }
    this.startSoloGame();
  }

  startSoloGame() {
    this.stopLocalGame();
    this.prepareForMatch(0);
    const host = new LudoHost({
      turnMs: 60_000,
      players: [0, 1, 2, 3].map((seat) => ({
        name: seat === 0 ? this.localProfileName || 'You' : SOLO_BOTS[seat],
        isBot: seat !== 0,
        active: true,
      })),
      send: (seat, payload) => {
        if (seat !== 0 || this.localHost !== host) return;
        setTimeout(() => {
          if (this.localHost !== host) return;
          if (payload.type === 'game_update') this.onGameUpdate(payload);
          else if (payload.type === 'action_error') this.onActionError(payload.error);
        }, 0);
      },
    });
    this.localHost = host;
    host.start();
  }

  prepareForMatch(localSeat) {
    this.localSeat = localSeat;
    this.waitingForAdminStart = false;
    this.view = null;
    this.awaiting = false;
    this.queue = Promise.resolve();
    this.resetAllPawnsVisual();
    this.arena.setMovablePawns(-1, []);
    this.arena.clearLandingPreviews();
    this.ui.clearMatchFeed?.();
  }

  sendAction(action) {
    this.awaiting = true;
    clearTimeout(this.awaitTimer);
    this.awaitTimer = setTimeout(() => {
      this.awaiting = false;
      this.syncHUD();
    }, 3000);
    if (this.localHost) this.localHost.handle(0, action);
    else if (this.inRoom()) this.network.sendAction(action);
    this.syncHUD();
  }

  onActionError(error) {
    this.awaiting = false;
    this.ui.showBanner(ERROR_TEXT[error] || 'That move is not allowed.', 'red');
    sound.vibrate(20);
    this.syncHUD();
  }

  // --- Rendering host updates ------------------------------------------------------
  onGameUpdate({ view, events = [] }) {
    // Animate updates strictly in order.
    this.queue = this.queue.then(() => this.applyUpdate(view, events)).catch((err) => console.error(err));
  }

  async applyUpdate(view, events) {
    const firstView = !this.view;
    this.awaiting = false;
    this.waitingForAdminStart = false;
    const prev = this.view;
    this.view = view;
    this.turnEndsAt = typeof view.turnMsLeft === 'number' ? Date.now() + view.turnMsLeft : null;

    if (firstView || !prev) {
      // Joining or rejoining mid-game: place everything without animation.
      this.players = this.rosterFromView(view);
      this.players.forEach((p) => this.arena.setSeatVisibility(p.id, p.activeSeat));
      this.snapAllPawns();
      if (events.some((e) => e.type === 'start')) {
        this.ui.pushMatchFeed?.('New 3D Ludo Match Started!');
      }
    } else {
      this.animating = true;
      this.syncHUD();
      // Play events against the previous positions, then adopt the new state.
      this.players = this.rosterFromView(prev);
      for (const e of events) await this.animateEvent(e, view);
      this.players = this.rosterFromView(view);
      this.animating = false;
    }

    this.players.forEach((p) => this.arena.setSeatVisibility(p.id, p.activeSeat));
    this.relayoutSharedTiles();
    this.arena.setTurnSpotlight(view.current);
    this.showChoicesIfMine();
    this.syncHUD();
    this.startTurnTimer();

    const win = events.find((e) => e.type === 'win');
    if (win) {
      this.stopTurnTimer();
      const winner = this.players[win.seat];
      sound.playSixChime();
      this.arena.triggerBurst(0, 0, winner.color.three, 2.2);
      this.ui.openVictoryModal(winner, win.seat === this.localSeat, win.standings.map((s) => ({
        ...s,
        name: s.seat === this.localSeat ? `${s.name} (You)` : s.name,
      })));
    } else if (!view.gameOver) {
      this.promptBanner();
    }
  }

  snapAllPawns() {
    this.players.forEach((p) => {
      p.pawns.forEach((prog, idx) => {
        const g = getPawnGridPos(p.id, idx, prog);
        const w = gridToWorld(g.row, g.col);
        const mesh = this.arena.pawns[p.id][idx];
        gsap.killTweensOf(mesh.position);
        mesh.position.set(w.x, prog < 0 ? 0.14 : 0.08, w.z);
      });
    });
  }

  async animateEvent(e, view) {
    const p = this.players[e.seat];
    const who = e.seat === this.localSeat ? 'You' : p?.rawName;
    switch (e.type) {
      case 'roll': {
        this.arena.setMovablePawns(-1, []);
        this.arena.clearLandingPreviews();
        sound.playDiceRattle();
        await this.arena.animateDiceRoll(e.roll);
        if (e.roll === 6) {
          sound.playSixChime();
          this.arena.triggerBurst(0, 0, p.color.three, 1.15);
        }
        if (e.lucky) {
          this.ui.showFloatingFX(`🍀 LUCKY 6 FOR ${p.rawName.toUpperCase()}!`, p.color.key);
          this.ui.pushMatchFeed?.(`🍀 ${who === 'You' ? 'You' : p.rawName} got a Lucky 6 after a long wait!`);
        } else {
          this.ui.pushMatchFeed?.(`${who} rolled a ${e.roll}${e.roll === 6 ? ' 🔥' : ''}`);
        }
        break;
      }
      case 'three_sixes':
        this.ui.showFloatingFX('THREE 6s! TURN SKIPPED', 'red');
        this.ui.pushMatchFeed?.(`${p.rawName} rolled 3 sixes — turn forfeited!`);
        await wait(700);
        break;
      case 'no_moves':
        this.ui.showBanner(`${who} rolled ${e.roll} — no legal moves`, p.color.key);
        await wait(650);
        break;
      case 'move':
        await this.animateMove(e);
        break;
      case 'capture': {
        const victim = this.players[e.victim];
        const g = getPawnGridPos(e.victim, e.pawn, e.from);
        const w = gridToWorld(g.row, g.col);
        sound.playCaptureBoom();
        this.arena.cinematicSwoopTo(w.x, w.z, 1.15);
        this.arena.triggerBurst(w.x, w.z, victim.color.three, 1.65);
        this.ui.pushMatchFeed?.(`💥 ${p.rawName} knocked out ${victim.rawName}!`);
        if (this.ui.playClashDuel) {
          await this.ui.playClashDuel(p.rawName, p.color, victim.rawName, victim.color);
        }
        await this.animateCaptureReturnToHome(e.victim, e.pawn, e.from);
        victim.pawns[e.pawn] = -1;
        break;
      }
      case 'home':
        sound.playSixChime();
        this.arena.triggerHomeFireworks(p.color.three);
        this.arena.cinematicSwoopTo(0, 0, 0.5);
        this.ui.showFloatingFX(`${p.rawName.toUpperCase()} REACHED HOME!`, p.color.key);
        this.ui.pushMatchFeed?.(`👑 ${p.rawName} brought a pawn HOME!`);
        await wait(400);
        break;
      case 'bonus': {
        const text = {
          capture: `💥 Capture Bonus! ${p.rawName} rolls again!`,
          home: `👑 Home Bonus! ${p.rawName} rolls again!`,
          six: `🎲 Rolled a 6! ${p.rawName} gets a Bonus Roll!`,
        }[e.reason];
        this.ui.showBanner(text, p.color.key);
        break;
      }
      case 'timeout':
        this.ui.pushMatchFeed?.(`⏱ Time up! Auto-playing for ${p.rawName}`);
        break;
      case 'player_away':
        if (e.seat !== this.localSeat) this.ui.pushMatchFeed?.(`📡 ${p.rawName} lost connection`);
        break;
      case 'player_back':
        if (e.seat !== this.localSeat) this.ui.pushMatchFeed?.(`✅ ${p.rawName} is back`);
        break;
      default:
        break;
    }
  }

  async animateMove(e) {
    const p = this.players[e.seat];
    const mesh = this.arena.pawns[e.seat][e.pawn];
    const steps = e.from === -1 ? [0] : Array.from({ length: e.to - e.from }, (_, i) => e.from + i + 1);
    for (let i = 0; i < steps.length; i++) {
      const g = getPawnGridPos(e.seat, e.pawn, steps[i]);
      const w = gridToWorld(g.row, g.col);
      sound.playPawnHop(i);
      this.arena.spawnHopTrailSpark(w.x, w.z, p.color.three);
      await this.arena.hopPawnToWorld(mesh, w.x, w.z, 0.08, 0.19);
    }
    p.pawns[e.pawn] = e.to;
    if (e.to >= 0 && e.to <= 50) {
      const g = getPawnGridPos(e.seat, e.pawn, e.to);
      if (SAFE_INDICES.has(g.outerIdx)) {
        const w = gridToWorld(g.row, g.col);
        this.arena.triggerSafeShieldDome(w.x, w.z);
      }
    }
  }

  async animateCaptureReturnToHome(oppSeat, pawnIdx, fromProgress) {
    const pawn = this.arena.pawns[oppSeat][pawnIdx];
    const oppColor = LUDO_COLORS[oppSeat].three;
    await new Promise((resolve) => {
      gsap.to(pawn.position, { y: 1.45, duration: 0.18, ease: 'power2.out', onComplete: resolve });
      gsap.to(pawn.rotation, { y: pawn.rotation.y + Math.PI * 4, duration: 0.55, ease: 'power2.out' });
    });
    const stride = fromProgress > 24 ? 3 : 2;
    let n = 0;
    for (let prog = fromProgress - stride; prog >= 0; prog -= stride) {
      const g = getPawnGridPos(oppSeat, pawnIdx, prog);
      const w = gridToWorld(g.row, g.col);
      sound.playRetreatZip(n++);
      await this.arena.hopPawnToWorld(pawn, w.x, w.z, 0.12, 0.055);
    }
    const [yr, yc] = HOME_YARDS[oppSeat][pawnIdx];
    const y = gridToWorld(yr, yc);
    await this.arena.hopPawnToWorld(pawn, y.x, y.z, 0.14, 0.28);
    pawn.rotation.y = 0;
    this.arena.triggerBurst(y.x, y.z, oppColor, 0.75);
  }

  relayoutSharedTiles() {
    // Pawns sharing a square stand side by side.
    const buckets = new Map();
    this.players.forEach((p) => {
      if (!p.activeSeat) return;
      p.pawns.forEach((prog, idx) => {
        const pos = getPawnGridPos(p.id, idx, prog);
        const key = `${pos.row.toFixed(1)}_${pos.col.toFixed(1)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ seat: p.id, idx, row: pos.row, col: pos.col, prog });
      });
    });
    const offsets = [[-0.14, -0.14], [0.14, 0.14], [-0.14, 0.14], [0.14, -0.14]];
    buckets.forEach((list) => {
      const base = gridToWorld(list[0].row, list[0].col);
      list.forEach((item, k) => {
        const [ox, oz] = list.length === 1 ? [0, 0] : offsets[k % 4];
        gsap.to(this.arena.pawns[item.seat][item.idx].position, {
          x: base.x + ox,
          y: item.prog < 0 ? 0.14 : 0.08,
          z: base.z + oz,
          duration: 0.22,
          ease: 'power2.out',
        });
      });
    });
  }

  showChoicesIfMine() {
    const v = this.view;
    if (v && !v.gameOver && v.phase === 'choose' && v.current === this.localSeat && v.movable.length) {
      this.arena.setMovablePawns(this.localSeat, v.movable);
      this.showLandingPreviews(v.dice, v.movable);
    } else {
      this.arena.setMovablePawns(-1, []);
      this.arena.clearLandingPreviews();
    }
  }

  showLandingPreviews(roll, movable) {
    const me = this.players[this.localSeat];
    const targets = movable.map((idx) => {
      const cur = me.pawns[idx];
      const next = cur === -1 ? 0 : cur + roll;
      const g = getPawnGridPos(this.localSeat, idx, next);
      const w = gridToWorld(g.row, g.col);
      let isCapture = false;
      if (next <= 50 && !SAFE_INDICES.has(g.outerIdx)) {
        for (const opp of this.players) {
          if (opp.id === this.localSeat || !opp.activeSeat) continue;
          opp.pawns.forEach((op, oi) => {
            if (op >= 0 && op <= 50 && getPawnGridPos(opp.id, oi, op).outerIdx === g.outerIdx) isCapture = true;
          });
        }
      }
      return { x: w.x, z: w.z, isCapture, colorThree: me.color.three };
    });
    this.arena.showLandingPreviews(targets);
  }

  promptBanner() {
    const v = this.view;
    const p = this.players[v.current];
    if (v.current === this.localSeat) {
      this.ui.showBanner(
        v.phase === 'choose'
          ? `You rolled ${v.dice}! Tap a glowing ${p.color.label} pawn to move`
          : `⚡ Your Turn (${p.color.label})! Tap the 3D Dice or Roll button${
              v.rules?.startOn1 && p.pawns.every((x) => x === -1) ? ' • a 6 or 1 brings a pawn out' : ''
            }`,
        p.color.key
      );
    } else {
      this.ui.showBanner(`${p.rawName}'s Turn${p.away ? ' (reconnecting)' : ''}...`, p.color.key);
    }
  }

  // --- Turn timer (display only; the host enforces it) ------------------------------
  startTurnTimer() {
    this.stopTurnTimer();
    if (!this.view || this.view.gameOver) return;
    const limit = Math.round((this.view.turnMs || 60000) / 1000);
    if (!this.turnEndsAt) {
      // Bots have no clock: show a full ring instead of a stale "0s".
      this.ui.updateTurnTimer?.(limit, limit, this.view.current);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((this.turnEndsAt - Date.now()) / 1000));
      this.ui.updateTurnTimer?.(Math.min(left, limit), limit, this.view.current);
    };
    tick();
    this.timerTick = setInterval(tick, 1000);
  }

  stopTurnTimer() {
    clearInterval(this.timerTick);
    this.timerTick = null;
  }

  // --- Player input --------------------------------------------------------------------
  canAct() {
    return Boolean(this.view && !this.view.gameOver && !this.isBusy && this.view.current === this.localSeat);
  }

  handleCanvasTap(clientX, clientY) {
    if (this.waitingForAdminStart || !this.view) return;
    const hit = this.arena.pickInteractive(clientX, clientY);
    if (!hit) return;
    if (hit.type === 'dice') this.requestRollDice();
    else if (hit.type === 'pawn' && hit.seat === this.localSeat) this.requestMovePawn(hit.pawnIndex);
  }

  requestRollDice() {
    if (!this.canAct() || this.view.phase !== 'roll') return;
    this.sendAction({ type: 'roll' });
  }

  requestMovePawn(pawnIndex) {
    if (!this.canAct() || this.view.phase !== 'choose') return;
    if (!this.view.movable.includes(pawnIndex)) {
      this.ui.showBanner(ERROR_TEXT.illegal_pawn, 'red');
      return;
    }
    this.arena.setMovablePawns(-1, []);
    this.arena.clearLandingPreviews();
    this.sendAction({ type: 'move', pawn: pawnIndex });
  }

  // --- Camera & HUD ----------------------------------------------------------------------
  cycleCameraView() {
    this.cameraPresetIndex = (this.cameraPresetIndex + 1) % 3;
    const presets = [
      { name: '3D View', pos: this.arena.baseCamPos.clone(), look: this.arena.baseLookAt.clone() },
      { name: 'Top-Down', pos: new THREE.Vector3(0, 15.2, 0.8), look: new THREE.Vector3(0, 0, 0) },
      { name: 'Close-Up', pos: new THREE.Vector3(0, 8.6, 8.6), look: new THREE.Vector3(0, 0, 0.5) },
    ];
    const p = presets[this.cameraPresetIndex];
    gsap.to(this.arena.camera.position, { x: p.pos.x, y: p.pos.y, z: p.pos.z, duration: 0.65, ease: 'power3.out' });
    gsap.to(this.arena.currentLookAt, { x: p.look.x, y: p.look.y, z: p.look.z, duration: 0.65, ease: 'power3.out' });
    return p.name;
  }

  syncHUD() {
    const v = this.view;
    this.ui.updateHUD({
      players: this.players.map((p) => ({
        id: p.id,
        color: p.color,
        name: p.name,
        rawName: p.rawName,
        activeSeat: p.activeSeat,
        isVacant: p.isVacant,
        finishedCount: p.finishedCount,
        isTurn: Boolean(v && !v.gameOver && p.id === v.current),
      })),
      currentPlayer: v ? v.current : 0,
      localSeat: this.localSeat,
      diceValue: v ? v.dice : 0,
      phase: v ? v.phase : 'roll',
      canRoll: this.canAct() && v.phase === 'roll',
      waitingForAdminStart: this.waitingForAdminStart,
    });
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
