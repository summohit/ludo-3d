import * as THREE from 'three';
import { gsap } from 'gsap';
import {
  LUDO_COLORS,
  SAFE_INDICES,
  HOME_YARDS,
  gridToWorld,
  getPawnGridPos,
} from './boardData.js';
import { sound } from './audio.js';

const BOT_NAMES = ['You', 'Nova (Bot)', 'Apex (Bot)', 'Blaze (Bot)'];

export class Ludo3DGame {
  constructor(arena, ui) {
    this.arena = arena;
    this.ui = ui;
    this.network = null;

    this.localSeat = 0;
    this.localProfileName = 'Player';
    this.isMultiplayerGuest = false;
    this.waitingForAdminStart = false;
    this.gameOver = true;
    this.isBusy = false;

    this.currentPlayer = 0;
    this.diceValue = 0;
    this.phase = 'roll'; // 'roll' | 'choose'
    this.consecutiveSixes = 0;
    this.cameraPresetIndex = 0;
    this.turnTimerLimit = 60; // 60-second turn timer before auto-play
    this.turnSecondsLeft = 60;
    this.turnTimerInterval = null;

    this.players = this._makeSoloRoster();
  }

  stopTurnTimer() {
    if (this.turnTimerInterval) {
      clearInterval(this.turnTimerInterval);
      this.turnTimerInterval = null;
    }
  }

  startTurnTimer() {
    this.stopTurnTimer();
    if (this.gameOver || this.waitingForAdminStart) return;
    this.turnSecondsLeft = this.turnTimerLimit;
    this.ui.updateTurnTimer?.(this.turnSecondsLeft, this.turnTimerLimit, this.currentPlayer);

    this.turnTimerInterval = setInterval(() => {
      if (this.gameOver || this.waitingForAdminStart) {
        this.stopTurnTimer();
        return;
      }
      this.turnSecondsLeft = Math.max(0, this.turnSecondsLeft - 1);
      this.ui.updateTurnTimer?.(this.turnSecondsLeft, this.turnTimerLimit, this.currentPlayer);

      if (this.turnSecondsLeft <= 0) {
        this.stopTurnTimer();
        // Only Host/Solo executes auto-play so multiplayer stays authoritative
        if (!this.isMultiplayerGuest && !this.isBusy) {
          const seat = this.currentPlayer;
          const p = this.players[seat];
          this.ui.pushMatchFeed?.(`⏱ Time up! Auto-playing for ${p.rawName}`, 'yellow');
          if (this.phase === 'roll') {
            this.executeRoll(seat);
          } else if (this.phase === 'choose') {
            const movable = this.getMovablePawns(seat, this.diceValue);
            if (movable.length > 0) {
              const autoIdx = this._pickSmartBotPawn(seat, this.diceValue, movable);
              this.executeMovePawn(seat, autoIdx);
            } else {
              this._advanceTurn();
            }
          }
        }
      }
    }, 1000);
  }

  async animateCaptureReturnToHome(oppSeat, pawnIdx, fromProgress) {
    const pawn = this.arena.pawns[oppSeat][pawnIdx];
    const oppColor = this.players[oppSeat].color.three;

    // 1. Knockup spin at the capture spot
    await new Promise((resolve) => {
      gsap.to(pawn.position, { y: 1.45, duration: 0.18, ease: 'power2.out', onComplete: resolve });
      gsap.to(pawn.rotation, { y: pawn.rotation.y + Math.PI * 4, duration: 0.55, ease: 'power2.out' });
    });

    // 2. Rapidly re-animate stepping backward along the track back to Start (0)
    const stepStride = fromProgress > 24 ? 3 : 2;
    let stepNum = 0;
    for (let prog = fromProgress - stepStride; prog >= 0; prog -= stepStride) {
      const g = getPawnGridPos(oppSeat, pawnIdx, prog);
      const w = gridToWorld(g.row, g.col);
      sound.playRetreatZip(stepNum++);
      await this.arena.hopPawnToWorld(pawn, w.x, w.z, 0.12, 0.055);
    }

    // 3. Final arc leaping back into the Home Yard pad with landing burst!
    const [yr, yc] = HOME_YARDS[oppSeat][pawnIdx];
    const yWorld = gridToWorld(yr, yc);
    await this.arena.hopPawnToWorld(pawn, yWorld.x, yWorld.z, 0.14, 0.28);
    pawn.rotation.y = 0;
    this.arena.triggerBurst(yWorld.x, yWorld.z, oppColor, 0.75);
  }

  attachNetwork(net) {
    this.network = net;
  }

  setLocalProfileName(name) {
    this.localProfileName = name || 'Player';
    if (!this.network || !this.network.isInRoom()) {
      this.players[0].name = `${this.localProfileName} (You)`;
      this.players[0].rawName = this.localProfileName;
      this.syncHUD();
    }
  }

  _makeSoloRoster() {
    return [0, 1, 2, 3].map((seat) => ({
      id: seat,
      color: LUDO_COLORS[seat],
      name: seat === 0 ? `${this.localProfileName} (You)` : BOT_NAMES[seat],
      rawName: seat === 0 ? this.localProfileName : BOT_NAMES[seat],
      isBot: seat !== 0,
      activeSeat: true,
      isVacant: false,
      pawns: [-1, -1, -1, -1], // progress: -1 = yard, 0..50 = outer, 51..55 = stretch, 56 = home
      finishedCount: 0,
      captures: 0,
    }));
  }

  configureRosterFromRoom(room, localSeat) {
    this.localSeat = localSeat;
    this.isMultiplayerGuest = Boolean(room && !this.network.isHost());
    this.players = [0, 1, 2, 3].map((seat) => {
      const occ = room?.players?.find((p) => p.seat === seat);
      if (occ) {
        return {
          id: seat,
          color: LUDO_COLORS[seat],
          name: seat === localSeat ? `${occ.name} (You)` : occ.name,
          rawName: occ.name,
          isBot: Boolean(occ.isBot),
          activeSeat: true,
          isVacant: false,
          pawns: this.players[seat]?.pawns || [-1, -1, -1, -1],
          finishedCount: this.players[seat]?.finishedCount || 0,
          captures: this.players[seat]?.captures || 0,
        };
      }
      return {
        id: seat,
        color: LUDO_COLORS[seat],
        name: 'VACANT SEAT',
        rawName: 'Vacant',
        isBot: false,
        activeSeat: false,
        isVacant: true,
        pawns: [-1, -1, -1, -1],
        finishedCount: 0,
        captures: 0,
      };
    });

    this.players.forEach((p) => {
      this.arena.setSeatVisibility(p.id, p.activeSeat && !p.isVacant);
    });
    this.syncHUD();
  }

  enterRoomWaitingState(room, localSeat) {
    this.stopTurnTimer();
    this.waitingForAdminStart = true;
    this.gameOver = true;
    this.isBusy = true;
    this.configureRosterFromRoom(room, localSeat);
    this.resetAllPawnsVisual();
    this.arena.setMovablePawns(-1, []);
  }

  resetAllPawnsVisual() {
    for (let seat = 0; seat < 4; seat++) {
      this.players[seat].pawns = [-1, -1, -1, -1];
      this.players[seat].finishedCount = 0;
      this.players[seat].captures = 0;
      for (let i = 0; i < 4; i++) {
        const pawn = this.arena.pawns[seat][i];
        const [r, c] = HOME_YARDS[seat][i];
        const pos = gridToWorld(r, c);
        gsap.killTweensOf(pawn.position);
        pawn.position.set(pos.x, 0.14, pos.z);
        pawn.scale.set(1, 1, 1);
      }
    }
  }

  startNewMatch() {
    if (this.isMultiplayerGuest) return;
    if (this.network && this.network.isInRoom()) {
      this.configureRosterFromRoom(this.network.room, this.localSeat);
    } else {
      this.localSeat = 0;
      this.isMultiplayerGuest = false;
      this.players = this._makeSoloRoster();
      for (let s = 0; s < 4; s++) this.arena.setSeatVisibility(s, true);
    }

    this.waitingForAdminStart = false;
    this.gameOver = false;
    this.isBusy = false;
    this.diceValue = 0;
    this.phase = 'roll';
    this.consecutiveSixes = 0;
    this.currentPlayer = this.players.find((p) => p.activeSeat)?.id ?? 0;

    this.resetAllPawnsVisual();
    this.arena.setMovablePawns(-1, []);
    this.arena.clearLandingPreviews();
    this.arena.setTurnSpotlight(this.currentPlayer);
    this.ui.clearMatchFeed?.();
    this.ui.pushMatchFeed?.('New 3D Ludo Match Started!', 'yellow');
    this.syncHUD();
    this.broadcastSnapshot({ type: 'match_started' });
    this._promptTurn();
  }

  _showLandingPreviewsForSeat(seat, roll, movable) {
    if (seat !== this.localSeat || !movable.length) {
      this.arena.clearLandingPreviews();
      return;
    }
    const p = this.players[seat];
    const targets = movable.map((idx) => {
      const cur = p.pawns[idx];
      const nextProg = cur === -1 ? 0 : cur + roll;
      const g = getPawnGridPos(seat, idx, nextProg);
      const w = gridToWorld(g.row, g.col);
      let isCapture = false;
      if (nextProg <= 50 && !SAFE_INDICES.has(g.outerIdx)) {
        for (const opp of this.players) {
          if (opp.id === seat || !opp.activeSeat) continue;
          for (let oi = 0; oi < 4; oi++) {
            const opProg = opp.pawns[oi];
            if (opProg >= 0 && opProg <= 50) {
              const opG = getPawnGridPos(opp.id, oi, opProg);
              if (opG.outerIdx === g.outerIdx) isCapture = true;
            }
          }
        }
      }
      return { x: w.x, z: w.z, isCapture, colorThree: p.color.three };
    });
    this.arena.showLandingPreviews(targets);
  }

  getMovablePawns(seat, roll) {
    const p = this.players[seat];
    if (!p || !p.activeSeat) return [];
    const movable = [];
    p.pawns.forEach((prog, idx) => {
      if (prog === -1 && roll === 6) {
        movable.push(idx);
      } else if (prog >= 0 && prog + roll <= 56) {
        movable.push(idx);
      }
    });
    return movable;
  }

  handleCanvasTap(clientX, clientY) {
    if (this.waitingForAdminStart || this.gameOver || this.isBusy) return;
    const hit = this.arena.pickInteractive(clientX, clientY);
    if (!hit) return;

    if (hit.type === 'dice') {
      this.requestRollDice();
    } else if (hit.type === 'pawn') {
      if (
        hit.seat === this.localSeat &&
        this.currentPlayer === this.localSeat &&
        this.phase === 'choose'
      ) {
        this.requestMovePawn(hit.pawnIndex);
      }
    }
  }

  requestRollDice() {
    if (
      this.waitingForAdminStart ||
      this.gameOver ||
      this.isBusy ||
      this.phase !== 'roll' ||
      this.currentPlayer !== this.localSeat
    ) {
      return;
    }
    if (this.isMultiplayerGuest) {
      this.network.sendGuestAction({ type: 'roll' });
      return;
    }
    this.executeRoll(this.localSeat);
  }

  requestMovePawn(pawnIndex) {
    if (
      this.waitingForAdminStart ||
      this.gameOver ||
      this.isBusy ||
      this.phase !== 'choose' ||
      this.currentPlayer !== this.localSeat
    ) {
      return;
    }
    if (this.isMultiplayerGuest) {
      this.network.sendGuestAction({ type: 'move', pawnIndex });
      return;
    }
    this.executeMovePawn(this.localSeat, pawnIndex);
  }

  async executeRoll(seat) {
    if (this.isBusy || this.gameOver || this.currentPlayer !== seat) return;
    this.isBusy = true;
    const player = this.players[seat];

    const roll = Math.floor(Math.random() * 6) + 1;
    this.diceValue = roll;
    sound.playDiceRattle();

    this.broadcastSnapshot({
      type: 'dice_rolled',
      seat,
      roll,
    });

    await this.arena.animateDiceRoll(roll);
    if (roll === 6) {
      sound.playSixChime();
      this.arena.triggerBurst(0, 0, player.color.three, 1.15);
    }

    this.ui.pushMatchFeed?.(
      `${seat === this.localSeat ? 'You' : player.rawName} rolled a ${roll}${roll === 6 ? ' 🔥' : ''}`,
      player.color.key
    );

    if (roll === 6) {
      this.consecutiveSixes += 1;
      if (this.consecutiveSixes >= 3) {
        this.ui.showFloatingFX('THREE 6s! TURN SKIPPED', 'red');
        this.ui.pushMatchFeed?.(`${player.rawName} rolled 3 sixes — turn forfeited!`, 'red');
        this.consecutiveSixes = 0;
        await new Promise((r) => setTimeout(r, 700));
        this.isBusy = false;
        this._advanceTurn();
        return;
      }
    } else {
      this.consecutiveSixes = 0;
    }

    const movable = this.getMovablePawns(seat, roll);
    if (movable.length === 0) {
      this.ui.showBanner(
        `${player.rawName} rolled ${roll} — no legal moves`,
        player.color.key
      );
      await new Promise((r) => setTimeout(r, 650));
      this.isBusy = false;
      this._advanceTurn();
      return;
    }

    this.phase = 'choose';
    this.isBusy = false;
    this.arena.setMovablePawns(seat, movable);
    this._showLandingPreviewsForSeat(seat, roll, movable);
    this.syncHUD();
    this.broadcastSnapshot({ type: 'choose_pawn', seat, roll, movable });

    if (player.isBot) {
      const chosen = this._pickSmartBotPawn(seat, roll, movable);
      setTimeout(() => this.executeMovePawn(seat, chosen), 520);
    } else if (movable.length === 1) {
      // Smooth auto-move when only 1 pawn can move!
      setTimeout(() => this.executeMovePawn(seat, movable[0]), 380);
    } else if (seat === this.localSeat) {
      this.ui.showBanner(
        `You rolled ${roll}! Tap a glowing ${player.color.label} pawn to move`,
        player.color.key
      );
    }
  }

  _pickSmartBotPawn(seat, roll, movable) {
    const p = this.players[seat];
    let bestIdx = movable[0];
    let bestScore = -999;

    for (const idx of movable) {
      const cur = p.pawns[idx];
      let score = 0;
      if (cur === -1 && roll === 6) {
        score = 85; // High priority to exit home yard
      } else {
        const nextProg = cur + roll;
        if (nextProg === 56) score = 120; // Reach center home!
        else if (nextProg >= 51) score = 70 + nextProg; // Safe home stretch
        else {
          const nextPos = getPawnGridPos(seat, idx, nextProg);
          // Check if this move captures an opponent!
          let canCapture = false;
          if (!SAFE_INDICES.has(nextPos.outerIdx)) {
            this.players.forEach((opp) => {
              if (opp.id !== seat && opp.activeSeat) {
                opp.pawns.forEach((opProg, opIdx) => {
                  if (opProg >= 0 && opProg <= 50) {
                    const opPos = getPawnGridPos(opp.id, opIdx, opProg);
                    if (opPos.outerIdx === nextPos.outerIdx) canCapture = true;
                  }
                });
              }
            });
          }
          if (canCapture) score = 110;
          else if (SAFE_INDICES.has(nextPos.outerIdx)) score = 60;
          else score = 20 + nextProg * 0.5;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }
    return bestIdx;
  }

  async executeMovePawn(seat, pawnIndex) {
    if (this.isBusy || this.gameOver || this.currentPlayer !== seat || this.phase !== 'choose') {
      return;
    }
    const movable = this.getMovablePawns(seat, this.diceValue);
    if (!movable.includes(pawnIndex)) return;

    this.isBusy = true;
    this.arena.setMovablePawns(-1, []);
    this.arena.clearLandingPreviews();
    const player = this.players[seat];
    const pawnMesh = this.arena.pawns[seat][pawnIndex];
    const startProg = player.pawns[pawnIndex];
    const roll = this.diceValue;

    let steps = [];
    if (startProg === -1) {
      steps = [0];
    } else {
      for (let s = 1; s <= roll; s++) {
        steps.push(startProg + s);
      }
    }

    // Hop step-by-step in 3D with glowing trail sparks!
    for (let i = 0; i < steps.length; i++) {
      const prog = steps[i];
      const gPos = getPawnGridPos(seat, pawnIndex, prog);
      const wPos = gridToWorld(gPos.row, gPos.col);
      sound.playPawnHop(i);
      this.arena.spawnHopTrailSpark(wPos.x, wPos.z, player.color.three);
      await this.arena.hopPawnToWorld(pawnMesh, wPos.x, wPos.z, 0.08, 0.19);
    }

    const finalProg = steps[steps.length - 1];
    player.pawns[pawnIndex] = finalProg;

    let grantBonusRoll = roll === 6;
    let captureHappened = false;

    // Check Center Home finish (with cinematic swoop + 3D fireworks!)
    if (finalProg === 56) {
      player.finishedCount += 1;
      grantBonusRoll = true;
      sound.playSixChime();
      this.arena.triggerHomeFireworks(player.color.three);
      this.arena.cinematicSwoopTo(0, 0, 0.5);
      this.ui.showFloatingFX(`${player.rawName.toUpperCase()} REACHED HOME!`, player.color.key);
      this.ui.pushMatchFeed?.(`👑 ${player.rawName} brought a pawn HOME!`, player.color.key);
    } else if (finalProg >= 0 && finalProg <= 50) {
      // Check Safe Star Shield Dome OR Captures on non-safe outer squares
      const landing = getPawnGridPos(seat, pawnIndex, finalProg);
      const landW = gridToWorld(landing.row, landing.col);
      if (SAFE_INDICES.has(landing.outerIdx)) {
        this.arena.triggerSafeShieldDome(landW.x, landW.z);
      } else {
        for (const opp of this.players) {
          if (opp.id === seat || !opp.activeSeat) continue;
          for (let oi = 0; oi < 4; oi++) {
            const opProg = opp.pawns[oi];
            if (opProg >= 0 && opProg <= 50) {
              const opPos = getPawnGridPos(opp.id, oi, opProg);
              if (opPos.outerIdx === landing.outerIdx) {
                // KNOCKOUT CAPTURE! Swoop camera & re-animate pawn retreating step-by-step home!
                captureHappened = true;
                grantBonusRoll = true;
                player.captures += 1;
                const capturedFromProg = opProg;
                opp.pawns[oi] = -1;
                sound.playCaptureBoom();
                this.arena.cinematicSwoopTo(landW.x, landW.z, 0.65);
                this.arena.triggerBurst(landW.x, landW.z, opp.color.three, 1.65);
                this.ui.showFloatingFX(
                  `💥 ${player.rawName.toUpperCase()} CAPTURED ${opp.rawName.toUpperCase()}!`,
                  player.color.key
                );
                this.ui.pushMatchFeed?.(
                  `💥 ${player.rawName} knocked out ${opp.rawName}!`,
                  player.color.key
                );
                await this.animateCaptureReturnToHome(opp.id, oi, capturedFromProg);
              }
            }
          }
        }
      }
    }

    this.relayoutSharedTiles();
    this.syncHUD();

    // Check Victory (all 4 pawns reached 56)
    if (player.finishedCount >= 4) {
      this.stopTurnTimer();
      this.gameOver = true;
      this.isBusy = false;
      sound.playSixChime();
      this.arena.triggerBurst(0, 0, player.color.three, 2.2);
      const standings = this.players
        .filter((p) => p.activeSeat && !p.isVacant)
        .map((p) => ({
          name: p.id === this.localSeat ? `${p.rawName} (You)` : p.rawName,
          homeCount: p.finishedCount,
          captures: p.captures,
          isWinner: p.id === seat,
        }))
        .sort((a, b) => b.homeCount - a.homeCount || b.captures - a.captures);
      this.broadcastSnapshot({ type: 'match_won', winnerSeat: seat, standings });
      this.ui.openVictoryModal(player, seat === this.localSeat, standings);
      return;
    }

    this.isBusy = false;
    if (grantBonusRoll) {
      this.phase = 'roll';
      if (captureHappened) {
        this.ui.showBanner(`💥 Capture Bonus! ${player.rawName} rolls again!`, player.color.key);
      } else if (finalProg === 56) {
        this.ui.showBanner(`👑 Home Bonus! ${player.rawName} rolls again!`, player.color.key);
      } else {
        this.ui.showBanner(`🎲 Rolled a 6! ${player.rawName} gets a Bonus Roll!`, player.color.key);
      }
      this.syncHUD();
      this.startTurnTimer();
      this.broadcastSnapshot({ type: 'bonus_roll', seat });
      if (player.isBot) {
        setTimeout(() => this.executeRoll(seat), 700);
      }
    } else {
      this._advanceTurn();
    }
  }

  relayoutSharedTiles() {
    // Group all active pawns on the same grid coordinate so they stand side-by-side cleanly
    const buckets = new Map();
    this.players.forEach((p) => {
      if (!p.activeSeat) return;
      p.pawns.forEach((prog, idx) => {
        if (prog < 0) return;
        const pos = getPawnGridPos(p.id, idx, prog);
        const key = `${pos.row.toFixed(1)}_${pos.col.toFixed(1)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ seat: p.id, idx, row: pos.row, col: pos.col });
      });
    });

    const offsets = [
      [0, 0],
      [-0.14, -0.14],
      [0.14, 0.14],
      [-0.14, 0.14],
      [0.14, -0.14],
    ];

    buckets.forEach((list) => {
      const wBase = gridToWorld(list[0].row, list[0].col);
      list.forEach((item, k) => {
        const [ox, oz] = list.length === 1 ? [0, 0] : offsets[(k % 4) + 1];
        const pawn = this.arena.pawns[item.seat][item.idx];
        gsap.to(pawn.position, {
          x: wBase.x + ox,
          z: wBase.z + oz,
          duration: 0.22,
          ease: 'power2.out',
        });
      });
    });
  }

  _advanceTurn() {
    if (this.gameOver) return;
    let next = this.currentPlayer;
    for (let guard = 0; guard < 8; guard++) {
      next = (next + 1) % 4;
      if (this.players[next].activeSeat && this.players[next].finishedCount < 4) break;
    }
    this.currentPlayer = next;
    this.phase = 'roll';
    this.consecutiveSixes = 0;
    this.arena.setMovablePawns(-1, []);
    this.arena.clearLandingPreviews();
    this.arena.setTurnSpotlight(this.currentPlayer);
    this.syncHUD();
    this.broadcastSnapshot({ type: 'turn_changed', seat: this.currentPlayer });
    this._promptTurn();
  }

  _promptTurn() {
    if (this.gameOver || this.waitingForAdminStart) return;
    this.startTurnTimer();
    const p = this.players[this.currentPlayer];
    if (this.currentPlayer === this.localSeat) {
      this.ui.showBanner(`⚡ Your Turn (${p.color.label})! Tap the 3D Dice or Roll button`, p.color.key);
    } else {
      this.ui.showBanner(`${p.rawName}'s Turn...`, p.color.key);
      if (p.isBot && !this.isMultiplayerGuest) {
        setTimeout(() => this.executeRoll(this.currentPlayer), 750);
      }
    }
  }

  handleRemoteAction(seat, action) {
    if (this.isMultiplayerGuest || this.gameOver || this.waitingForAdminStart) return;
    if (seat !== this.currentPlayer) return;
    if (action.type === 'roll') this.executeRoll(seat);
    if (action.type === 'move') this.executeMovePawn(seat, action.pawnIndex);
  }

  broadcastSnapshot(event = null) {
    if (!this.network || !this.network.isInRoom() || !this.network.isHost()) return;
    const state = {
      currentPlayer: this.currentPlayer,
      diceValue: this.diceValue,
      phase: this.phase,
      gameOver: this.gameOver,
      waitingForAdminStart: this.waitingForAdminStart,
      players: this.players.map((p) => ({
        id: p.id,
        rawName: p.rawName,
        isBot: p.isBot,
        activeSeat: p.activeSeat,
        isVacant: p.isVacant,
        pawns: [...p.pawns],
        finishedCount: p.finishedCount,
        captures: p.captures,
      })),
    };
    this.network.syncStateFromHost(state, event);
  }

  applyRemoteSnapshot(state, event = null) {
    if (!state) return;
    this.isMultiplayerGuest = true;
    this.waitingForAdminStart = Boolean(state.waitingForAdminStart);
    this.currentPlayer = state.currentPlayer;
    this.diceValue = state.diceValue;
    this.phase = state.phase;
    this.gameOver = state.gameOver;

    state.players.forEach((sp) => {
      const p = this.players[sp.id];
      p.rawName = sp.rawName;
      p.name = sp.isVacant ? 'VACANT SEAT' : sp.id === this.localSeat ? `${sp.rawName} (You)` : sp.rawName;
      p.isBot = sp.isBot;
      p.activeSeat = sp.activeSeat;
      p.isVacant = sp.isVacant;
      p.pawns = [...sp.pawns];
      p.finishedCount = sp.finishedCount;
      p.captures = sp.captures;
      this.arena.setSeatVisibility(sp.id, sp.activeSeat && !sp.isVacant);

      p.pawns.forEach((prog, idx) => {
        const g = getPawnGridPos(sp.id, idx, prog);
        const w = gridToWorld(g.row, g.col);
        gsap.to(this.arena.pawns[sp.id][idx].position, {
          x: w.x,
          y: prog < 0 ? 0.14 : 0.08,
          z: w.z,
          duration: 0.35,
          ease: 'power2.out',
        });
      });
    });

    this.relayoutSharedTiles();
    this.arena.setTurnSpotlight(this.currentPlayer);

    if (event?.type === 'dice_rolled') {
      sound.playDiceRattle();
      this.arena.animateDiceRoll(event.roll);
    }
    if (event?.type === 'choose_pawn' && event.seat === this.localSeat) {
      this.arena.setMovablePawns(this.localSeat, event.movable || []);
      this._showLandingPreviewsForSeat(this.localSeat, this.diceValue, event.movable || []);
    } else {
      this.arena.setMovablePawns(-1, []);
      this.arena.clearLandingPreviews();
    }
    if (event?.type === 'match_won') {
      this.ui.openVictoryModal(
        this.players[event.winnerSeat],
        event.winnerSeat === this.localSeat,
        event.standings || []
      );
    }

    this.syncHUD();
    this._promptTurn();
  }

  cycleCameraView() {
    this.cameraPresetIndex = (this.cameraPresetIndex + 1) % 3;
    const presets = [
      { name: '3D View', pos: this.arena.baseCamPos.clone(), look: this.arena.baseLookAt.clone() },
      { name: 'Top-Down', pos: new THREE.Vector3(0, 15.2, 0.8), look: new THREE.Vector3(0, 0, 0) },
      { name: 'Close-Up', pos: new THREE.Vector3(0, 8.6, 8.6), look: new THREE.Vector3(0, 0, 0.5) },
    ];
    const p = presets[this.cameraPresetIndex];
    gsap.to(this.arena.camera.position, {
      x: p.pos.x,
      y: p.pos.y,
      z: p.pos.z,
      duration: 0.65,
      ease: 'power3.out',
    });
    gsap.to(this.arena.currentLookAt, {
      x: p.look.x,
      y: p.look.y,
      z: p.look.z,
      duration: 0.65,
      ease: 'power3.out',
    });
    return p.name;
  }

  syncHUD() {
    this.ui.updateHUD({
      players: this.players.map((p) => ({
        id: p.id,
        color: p.color,
        name: p.name,
        rawName: p.rawName,
        activeSeat: p.activeSeat,
        isVacant: p.isVacant,
        finishedCount: p.finishedCount,
        isTurn: !this.waitingForAdminStart && !this.gameOver && p.id === this.currentPlayer,
      })),
      currentPlayer: this.currentPlayer,
      localSeat: this.localSeat,
      diceValue: this.diceValue,
      phase: this.phase,
      canRoll:
        !this.waitingForAdminStart &&
        !this.gameOver &&
        !this.isBusy &&
        this.phase === 'roll' &&
        this.currentPlayer === this.localSeat,
      waitingForAdminStart: this.waitingForAdminStart,
    });
  }
}
