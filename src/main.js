import { Ludo3DArena } from './scene.js';
import { Ludo3DGame } from './game.js';
import { LudoNetworkClient } from './network.js';
import { LUDO_COLORS } from './boardData.js';
import { sound } from './audio.js';

// Hamburger Navigation Drawer
const drawer = document.getElementById('nav-drawer');
const openDrawerBtn = document.getElementById('drawer-open');
const closeDrawerBtn = document.getElementById('drawer-close');
const drawerScroller = drawer.querySelector('.Drawer-scroller');
const drawerSheet = drawer.querySelector('.Drawer-sheet');

async function openDrawer() {
  drawer.showModal();
  if (!CSS.supports('scroll-initial-target', 'nearest')) {
    drawerScroller.scrollTo({ left: drawerScroller.offsetWidth, behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  drawerScroller.scrollTo({ left: 0, behavior: 'auto' });
}

function closeDrawer() {
  if (drawer.open) drawer.close();
}

openDrawerBtn.addEventListener('click', openDrawer);
closeDrawerBtn.addEventListener('click', closeDrawer);
drawer.addEventListener('click', (e) => {
  if (!drawerSheet.contains(e.target)) closeDrawer();
});

// Local Profile
const STORAGE_KEY = 'ludo_3d_profile_v1';
const profile = { displayName: 'Player', coins: 500 };
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) Object.assign(profile, JSON.parse(raw));
} catch (_) {}

function saveProfile() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch (_) {}
}

// DOM Refs
const canvas = document.getElementById('ludo-canvas');
const homeScreen = document.getElementById('home-screen');
const homeForm = document.getElementById('home-form');
const homeNameInput = document.getElementById('home-player-name');
const homeAvatar = document.getElementById('home-avatar');
const hudAvatarLetter = document.getElementById('hud-avatar-letter');
const onlineDot = document.getElementById('online-dot');
const onlineText = document.getElementById('online-text');
const turnBanner = document.getElementById('turn-banner');
const fxCallout = document.getElementById('fx-callout');
const rollDiceBtn = document.getElementById('roll-dice-btn');
const rollBtnText = document.getElementById('roll-btn-text');
const activeColorOrb = document.getElementById('active-color-orb');
const activeTurnText = document.getElementById('active-turn-text');
const dicePillVal = document.getElementById('dice-pill-val');
const turnTimerPill = document.getElementById('turn-timer-pill');
const matchFeedList = document.getElementById('match-feed-list');

const mpDialog = document.getElementById('multiplayer-dialog');
const mpEntryForms = document.getElementById('mp-entry-forms');
const mpStatusBanner = document.getElementById('mp-status-banner');
const mpDialogTitle = document.getElementById('mp-dialog-title');
const mpTabCreate = document.getElementById('mp-tab-create');
const mpTabJoin = document.getElementById('mp-tab-join');
const rulesDialog = document.getElementById('rules-dialog');
const victoryDialog = document.getElementById('victory-dialog');

const tableWaitingOverlay = document.getElementById('table-waiting-overlay');
const overlayRoomName = document.getElementById('overlay-room-name');
const overlayRoomCode = document.getElementById('overlay-room-code');
const overlayWaitingStatus = document.getElementById('overlay-waiting-status');
const overlaySeatList = document.getElementById('overlay-seat-list');
const overlayAdminStartBtn = document.getElementById('overlay-admin-start-btn');

let fxTimer = null;
const reactionTimers = new Map();

function showSeatReaction(seat, emoji) {
  const bubble = document.getElementById(`reaction-${seat}`);
  if (!bubble) return;
  bubble.textContent = emoji;
  bubble.classList.add('show');
  if (reactionTimers.has(seat)) clearTimeout(reactionTimers.get(seat));
  reactionTimers.set(seat, setTimeout(() => bubble.classList.remove('show'), 1800));
}

const ui = {
  showBanner(text, colorKey) {
    turnBanner.textContent = text;
    const lc = LUDO_COLORS.find((c) => c.key === colorKey);
    turnBanner.style.borderColor = lc ? lc.glow : 'rgba(129, 140, 248, 0.4)';
  },

  updateTurnTimer(secondsLeft, totalLimit = 60, activeSeat = 0) {
    if (turnTimerPill) {
      turnTimerPill.textContent = `⏱ ${secondsLeft}s`;
      turnTimerPill.classList.toggle('warn', secondsLeft <= 15 && secondsLeft > 5);
      turnTimerPill.classList.toggle('urgent', secondsLeft <= 5);
    }

    const circumference = 2 * Math.PI * 19; // r=19 => ~119.38
    const ratio = Math.max(0, Math.min(1, secondsLeft / Math.max(1, totalLimit)));
    const dashOffset = circumference * (1 - ratio);

    for (let s = 0; s < 4; s++) {
      const arc = document.getElementById(`timer-arc-${s}`);
      if (!arc) continue;
      if (s === activeSeat) {
        arc.style.strokeDasharray = `${circumference}`;
        arc.style.strokeDashoffset = `${dashOffset}`;
        arc.classList.toggle('warn', secondsLeft <= 15 && secondsLeft > 5);
        arc.classList.toggle('urgent', secondsLeft <= 5);
      } else {
        arc.style.strokeDasharray = `${circumference}`;
        arc.style.strokeDashoffset = `${circumference}`;
        arc.classList.remove('warn', 'urgent');
      }
    }
  },

  showFloatingFX(text, colorKey = 'yellow') {
    const lc = LUDO_COLORS.find((c) => c.key === colorKey) || LUDO_COLORS[2];
    fxCallout.textContent = text;
    fxCallout.style.borderColor = lc.glow;
    fxCallout.classList.add('visible');
    if (fxTimer) clearTimeout(fxTimer);
    fxTimer = setTimeout(() => fxCallout.classList.remove('visible'), 1500);
  },

  clearMatchFeed() {
    matchFeedList.innerHTML = '';
  },

  pushMatchFeed(text) {
    const li = document.createElement('li');
    li.textContent = text;
    matchFeedList.prepend(li);
    while (matchFeedList.children.length > 3) {
      matchFeedList.removeChild(matchFeedList.lastElementChild);
    }
  },

  openVictoryModal(winner, isMe, standings) {
    if (isMe) {
      profile.coins += 300;
      saveProfile();
      syncProfileUI();
    }
    document.getElementById('victory-dialog-title').textContent = isMe
      ? 'Ludo 3D Champion!'
      : `${winner.rawName} Wins!`;
    document.getElementById('victory-subtitle').textContent = isMe
      ? 'All 4 of your pawns reached the Center Crown! (+300 🪙)'
      : `${winner.rawName} got all 4 pawns home first.`;

    const list = document.getElementById('victory-podium-list');
    list.innerHTML = '';
    const medals = ['🥇', '🥈', '🥉', '4️⃣'];
    standings.forEach((s, idx) => {
      const li = document.createElement('li');
      li.className = `podium-row ${s.isWinner ? 'winner-row' : ''}`;
      li.innerHTML = `<span>${medals[idx] || idx + 1} ${s.name}</span><span>${s.homeCount}/4 Home • ${s.captures} 💥</span>`;
      list.appendChild(li);
    });
    victoryDialog.returnValue = '';
    if (!victoryDialog.open) victoryDialog.showModal();
  },

  updateHUD(state) {
    const activeCol = LUDO_COLORS[state.currentPlayer] || LUDO_COLORS[0];
    activeColorOrb.style.backgroundColor = activeCol.hex;
    activeColorOrb.style.boxShadow = `0 0 12px ${activeCol.glow}`;
    activeTurnText.textContent = `${activeCol.label.toUpperCase()}'S TURN`;
    dicePillVal.textContent = `🎲 ${state.diceValue || '—'}`;

    rollDiceBtn.disabled = !state.canRoll;
    rollBtnText.textContent = state.canRoll
      ? 'ROLL 3D DICE'
      : state.phase === 'choose' && state.currentPlayer === state.localSeat
        ? `PICK PAWN (${state.diceValue})`
        : 'WAIT FOR TURN';

    const playing = !state.waitingForAdminStart && !game.gameOver;
    state.players.forEach((p) => {
      const el = document.getElementById(`seat-${p.id}`);
      const nameEl = document.getElementById(`name-${p.id}`);
      const homeEl = document.getElementById(`home-${p.id}`);
      if (el) {
        el.classList.toggle('active-turn', p.isTurn);
        el.classList.toggle('vacant-seat', p.isVacant);
        el.classList.toggle('blurred-inactive', playing && !p.isTurn && !p.isVacant);
      }
      if (nameEl) nameEl.textContent = p.isVacant ? 'VACANT SEAT' : p.name;
      if (homeEl) {
        homeEl.textContent = p.isVacant
          ? 'Waiting...'
          : `${p.finishedCount} / 4 Home`;
      }
    });
  },
};

const arena = new Ludo3DArena(canvas);
// Older browsers without overflow: clip: never let the shell scroll (it shifts the 3D view).
const appShell = document.getElementById('app-shell');
appShell?.addEventListener('scroll', () => {
  if (appShell.scrollTop || appShell.scrollLeft) appShell.scrollTo(0, 0);
});
const game = new Ludo3DGame(arena, ui);

function syncProfileUI() {
  const ch = (profile.displayName || 'P').trim().charAt(0).toUpperCase() || 'P';
  homeAvatar.textContent = ch;
  hudAvatarLetter.textContent = ch;
  document.getElementById('top-coins-text').textContent = String(profile.coins);
  homeNameInput.value = profile.displayName;
  document.getElementById('create-player-name').value = profile.displayName;
  document.getElementById('join-player-name').value = profile.displayName;
  game.setLocalProfileName(profile.displayName);
}

function showHomeScreen() {
  if (network.isInRoom()) network.leaveRoom();
  game.stopTurnTimer();
  tableWaitingOverlay.hidden = true;
  game.gameOver = true;
  homeScreen.hidden = false;
  document.body.classList.add('home-active');
}

function hideHomeScreen() {
  homeScreen.hidden = true;
  document.body.classList.remove('home-active');
}

function setMpMode(mode) {
  const active = mode === 'join' ? 'join' : 'create';
  mpDialog.dataset.mode = active;
  mpEntryForms.dataset.mode = active;
  mpDialogTitle.textContent = active === 'join' ? 'Join Ludo Room' : 'Create a New Room';
  mpTabCreate.classList.toggle('active', active === 'create');
  mpTabJoin.classList.toggle('active', active === 'join');
}

function openMpModal(mode = 'create') {
  setMpMode(mode);
  mpDialog.returnValue = '';
  if (!mpDialog.open) mpDialog.showModal();
}

function renderWaitingRoom(room, localSeat) {
  if (!room || room.started) {
    tableWaitingOverlay.hidden = true;
    return;
  }
  tableWaitingOverlay.hidden = false;
  overlayRoomName.textContent = room.roomName;
  overlayRoomCode.textContent = room.code;
  const isAdmin = network.isHost();

  overlayWaitingStatus.innerHTML = isAdmin
    ? `You are the <strong>Room Admin</strong>. Other seats are <strong>VACANT</strong> waiting for friends (Code: <strong>${room.code}</strong>). Game waits until you click Start Game!`
    : `Joined <strong>${room.roomName}</strong>! Waiting for Room Admin to start...`;

  overlaySeatList.innerHTML = '';
  for (let s = 0; s < 4; s++) {
    const occ = room.players.find((p) => p.seat === s);
    const li = document.createElement('li');
    li.className = `waiting-seat-slot ${occ ? '' : 'vacant'}`;
    const colLabel = LUDO_COLORS[s].label;
    li.innerHTML = `<span style="font-size:0.7rem;color:#94a3b8;font-weight:700">${colLabel.toUpperCase()} SEAT ${s === 0 ? '• ADMIN' : ''}</span><strong>${occ ? (s === localSeat ? `${occ.name} (You)` : occ.name) : 'Vacant — Waiting...'}</strong>`;

    if (isAdmin && s > 0 && (!occ || occ.isBot)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seat-bot-toggle-btn';
      btn.textContent = occ?.isBot ? '✕ Remove Bot' : '+ Add AI Bot';
      btn.addEventListener('click', () => network.toggleSeatBot(s));
      li.appendChild(btn);
    }
    overlaySeatList.appendChild(li);
  }

  overlayAdminStartBtn.hidden = !isAdmin;
  overlayAdminStartBtn.textContent =
    room.players.length >= 2
      ? `▶ Start Game Now (${room.players.length}/4)`
      : '▶ Start Game (Need 2+ Players)';
}

const network = new LudoNetworkClient({
  onConnectionChange(connected) {
    onlineDot.classList.toggle('live', connected);
    if (!connected) onlineText.textContent = 'Offline • Solo Ready';
  },
  onOnlineCount(count) {
    onlineDot.classList.add('live');
    onlineText.textContent = `Online • ${count} ${count === 1 ? 'player' : 'players'}`;
  },
  onRoomJoined(room, seat, lastState) {
    hideHomeScreen();
    if (mpDialog.open) mpDialog.close();
    if (!room.started) {
      game.enterRoomWaitingState(room, seat);
      renderWaitingRoom(room, seat);
    } else {
      tableWaitingOverlay.hidden = true;
      game.configureRosterFromRoom(room, seat);
      if (lastState && !network.isHost()) game.applyRemoteSnapshot(lastState);
    }
  },
  onRoomUpdated(room, seat) {
    if (!room.started) {
      game.enterRoomWaitingState(room, seat);
      renderWaitingRoom(room, seat);
    } else {
      game.configureRosterFromRoom(room, seat);
    }
  },
  onRoomError(msg) {
    mpStatusBanner.textContent = msg;
    overlayWaitingStatus.textContent = msg;
  },
  onMatchStarted(room, seat) {
    hideHomeScreen();
    tableWaitingOverlay.hidden = true;
    game.configureRosterFromRoom(room, seat);
    if (network.isHost()) game.startNewMatch();
  },
  onGameStateSync(state, ev) {
    tableWaitingOverlay.hidden = true;
    game.applyRemoteSnapshot(state, ev);
  },
  onRemotePlayerAction(seat, action) {
    game.handleRemoteAction(seat, action);
  },
  onRoomEmote(seat, _name, emote) {
    showSeatReaction(seat, emote);
  },
});

game.attachNetwork(network);

// Cursor-Following Turn Indicator when hovering 3D Dice or Roll Button
const diceCursorTip = document.getElementById('dice-cursor-tip');
const diceTipDot = document.getElementById('dice-tip-dot');
const diceTipText = document.getElementById('dice-tip-text');

function showDiceCursorTip(clientX, clientY) {
  if (!diceCursorTip || game.gameOver || game.waitingForAdminStart) {
    hideDiceCursorTip();
    return;
  }
  const isMyRoll =
    game.currentPlayer === game.localSeat &&
    game.phase === 'roll' &&
    !game.isBusy;
  const activePlayer = game.players[game.currentPlayer];
  const activeCol = activePlayer?.color || LUDO_COLORS[0];

  diceTipDot.style.backgroundColor = activeCol.hex;
  diceTipDot.style.boxShadow = `0 0 8px ${activeCol.glow}`;

  if (isMyRoll) {
    diceTipText.textContent = '🎲 Click to Roll Dice!';
    diceCursorTip.classList.remove('locked');
    canvas.style.cursor = 'pointer';
  } else if (game.currentPlayer === game.localSeat && game.phase === 'choose') {
    diceTipText.textContent = `👆 Pick a glowing ${activeCol.label} pawn!`;
    diceCursorTip.classList.add('locked');
    canvas.style.cursor = 'not-allowed';
  } else {
    diceTipText.textContent = `🔒 Wait! ${activePlayer?.rawName || 'Opponent'}'s Turn`;
    diceCursorTip.classList.add('locked');
    canvas.style.cursor = 'not-allowed';
  }

  diceCursorTip.style.left = `${clientX + 16}px`;
  diceCursorTip.style.top = `${clientY - 14}px`;
  diceCursorTip.hidden = false;
}

function hideDiceCursorTip() {
  if (diceCursorTip) diceCursorTip.hidden = true;
  canvas.style.cursor = 'pointer';
}

// Event Listeners
// 'click' (after the tap ends), not 'pointerdown': on phones a dialog opened on
// touch-down receives the same tap's click on its backdrop and closes at once.
canvas.addEventListener('click', (e) => game.handleCanvasTap(e.clientX, e.clientY));
canvas.addEventListener('pointermove', (e) => {
  if (game.gameOver || game.waitingForAdminStart) {
    hideDiceCursorTip();
    return;
  }
  const hit = arena.pickInteractive(e.clientX, e.clientY);
  if (hit && hit.type === 'dice') {
    showDiceCursorTip(e.clientX, e.clientY);
  } else {
    hideDiceCursorTip();
  }
});
canvas.addEventListener('pointerleave', hideDiceCursorTip);

rollDiceBtn.addEventListener('pointermove', (e) => {
  if (game.currentPlayer !== game.localSeat && !game.gameOver && !game.waitingForAdminStart) {
    showDiceCursorTip(e.clientX, e.clientY);
  }
});
rollDiceBtn.addEventListener('pointerleave', hideDiceCursorTip);
rollDiceBtn.addEventListener('click', () => game.requestRollDice());

homeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = homeNameInput.value.trim();
  if (name.length < 2) return;
  profile.displayName = name;
  saveProfile();
  syncProfileUI();
  const mode = e.submitter?.value || 'bots';
  if (mode === 'bots') {
    hideHomeScreen();
    game.startNewMatch();
  } else {
    openMpModal(mode);
  }
});

homeNameInput.addEventListener('input', () => {
  const ch = (homeNameInput.value || 'P').trim().charAt(0).toUpperCase() || 'P';
  homeAvatar.textContent = ch;
});

const clearNameBtn = document.getElementById('clear-name-btn');
if (clearNameBtn) {
  clearNameBtn.addEventListener('click', () => {
    homeNameInput.value = '';
    homeAvatar.textContent = 'P';
    homeNameInput.focus();
  });
}

homeAvatar.addEventListener('click', openDrawer);
document.getElementById('hud-avatar-btn').addEventListener('click', openDrawer);

mpTabCreate.addEventListener('click', () => setMpMode('create'));
mpTabJoin.addEventListener('click', () => setMpMode('join'));
document.getElementById('close-mp-btn').addEventListener('click', () => mpDialog.close());
document.getElementById('close-rules-btn').addEventListener('click', () => rulesDialog.close());

document.getElementById('create-room-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const rn = document.getElementById('create-room-name').value.trim() || 'ludo-party';
  const pn = document.getElementById('create-player-name').value.trim() || profile.displayName;
  network.createRoom(rn, pn);
});

document.getElementById('join-room-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const rc = document.getElementById('join-room-code').value.trim();
  const pn = document.getElementById('join-player-name').value.trim() || profile.displayName;
  network.joinRoom(rc, pn);
});

document.getElementById('overlay-copy-code-btn').addEventListener('click', () => {
  if (network.room) navigator.clipboard?.writeText(network.room.code);
});
document.getElementById('overlay-copy-link-btn').addEventListener('click', () => {
  if (!network.room) return;
  const url = `${window.location.origin}${window.location.pathname}?room=${network.room.code}`;
  navigator.clipboard?.writeText(url);
  overlayWaitingStatus.textContent = `Copied invite link: ${url}`;
});
overlayAdminStartBtn.addEventListener('click', () => network.requestAdminStartMatch());
document.getElementById('overlay-leave-room-btn').addEventListener('click', showHomeScreen);

// Drawer Menu Actions
document.getElementById('menu-home-btn').addEventListener('click', () => {
  closeDrawer();
  showHomeScreen();
});
document.getElementById('menu-mp-btn').addEventListener('click', () => {
  closeDrawer();
  openMpModal('create');
});
document.getElementById('menu-rules-btn').addEventListener('click', () => {
  closeDrawer();
  rulesDialog.showModal();
});
document.getElementById('menu-sound-btn').addEventListener('click', () => {
  sound.muted = !sound.muted;
  document.getElementById('drawer-sound-icon').textContent = sound.muted ? '🔇' : '🔊';
  document.getElementById('drawer-sound-title').textContent = sound.muted
    ? 'Sound & Haptics: MUTED'
    : 'Sound & Haptics: ON';
});

document.getElementById('camera-switch-btn').addEventListener('click', () => {
  const name = game.cycleCameraView();
  document.getElementById('camera-view-label').textContent = name;
});

document.querySelectorAll('.emote-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const emote = btn.dataset.emote;
    if (network.isInRoom()) {
      network.sendEmote(profile.displayName, emote);
    } else {
      showSeatReaction(game.localSeat, emote);
      const botSeats = [1, 2, 3];
      const randomBot = botSeats[Math.floor(Math.random() * botSeats.length)];
      setTimeout(() => showSeatReaction(randomBot, emote === '😱' ? '😂' : '🔥'), 520);
    }
  });
});

victoryDialog.addEventListener('close', () => {
  const v = victoryDialog.returnValue;
  victoryDialog.returnValue = '';
  if (v === 'rematch') game.startNewMatch();
  else if (v === 'home') showHomeScreen();
});

// Check URL invite ?room=XXXXXX
const invited = new URLSearchParams(window.location.search).get('room');
if (invited && invited.trim().length >= 2) {
  document.getElementById('join-room-code').value = invited.trim();
  setTimeout(() => openMpModal('join'), 400);
}

syncProfileUI();
arena.startRenderLoop();
showHomeScreen();
