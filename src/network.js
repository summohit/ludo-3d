// Thin WebSocket client. The server runs the game; this only sends requests
// and passes server messages to the handlers.
//
// Rejoining: each browser keeps a private token and sends it on every connect,
// so after a refresh or a dropped connection the server restores the seat.

const TOKEN_KEY = 'ludo_arena_player_token_v1';

function loadToken() {
  const fresh = () => {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };
  try {
    let t = localStorage.getItem(TOKEN_KEY);
    if (!t || !/^[A-Za-z0-9_-]{16,64}$/.test(t)) {
      t = fresh();
      localStorage.setItem(TOKEN_KEY, t);
    }
    return t;
  } catch {
    return fresh();
  }
}

export class LudoNetworkClient {
  constructor(handlers) {
    this.handlers = handlers;
    this.token = loadToken();
    this.ws = null;
    this.myId = null;
    this.room = null;
    this.localSeat = 0;
    this.isConnected = false;
    this.retryMs = 1000;
    this._connect();
  }

  _connect() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      this.ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    } catch {
      this._retry();
      return;
    }
    this.ws.addEventListener('open', () => {
      this.isConnected = true;
      this.retryMs = 1000;
      this.ws.send(JSON.stringify({ type: 'hello', token: this.token }));
      this.handlers.onConnectionChange?.(true, Boolean(this.room));
    });
    this.ws.addEventListener('message', (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._onMessage(data);
    });
    this.ws.addEventListener('close', () => {
      this.isConnected = false;
      this.handlers.onConnectionChange?.(false, Boolean(this.room));
      this._retry();
    });
  }

  _retry() {
    setTimeout(() => this._connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 1.6, 8000);
  }

  _setRoom(data) {
    this.room = data.room;
    this.localSeat = data.seat;
    if (data.you) this.myId = data.you;
  }

  _onMessage(data) {
    const h = this.handlers;
    switch (data.type) {
      case 'welcome':
        if (typeof data.onlineCount === 'number') h.onOnlineCount?.(data.onlineCount);
        break;
      case 'online_count':
        h.onOnlineCount?.(data.count);
        break;
      case 'no_room':
        if (this.room) {
          this.room = null;
          h.onRoomLost?.();
        }
        break;
      case 'session_replaced':
        this.room = null;
        h.onRoomLost?.('This game is open in another tab, so this tab left the room.');
        break;
      case 'room_joined':
        this._setRoom(data);
        h.onRoomJoined?.(this.room, this.localSeat);
        break;
      case 'room_updated':
        if (!this.room) return;
        this._setRoom(data);
        h.onRoomUpdated?.(this.room, this.localSeat);
        break;
      case 'match_started':
        this._setRoom(data);
        h.onMatchStarted?.(this.room, this.localSeat);
        break;
      case 'room_error':
        h.onRoomError?.(data.message);
        break;
      case 'game_update':
        if (this.room) h.onGameUpdate?.(data);
        break;
      case 'action_error':
        h.onActionError?.(data.error);
        break;
      case 'player_joined':
        h.onPlayerJoined?.(data.name, data.seat);
        break;
      case 'player_left':
        h.onPlayerLeft?.(data.name, data.seat);
        break;
      case 'room_emote':
        h.onRoomEmote?.(data.seat, data.playerName, data.emote);
        break;
    }
  }

  _send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  isInRoom() {
    return Boolean(this.room);
  }

  isHost() {
    return Boolean(this.room && this.myId && this.room.hostId === this.myId);
  }

  createRoom(roomName, playerName) {
    if (!this._send({ type: 'create_room', roomName, playerName })) {
      this.handlers.onRoomError?.('Not connected to the game server. Try again in a moment.');
    }
  }

  joinRoom(roomCode, playerName) {
    if (!this._send({ type: 'join_room', roomCode, playerName })) {
      this.handlers.onRoomError?.('Not connected to the game server. Try again in a moment.');
    }
  }

  toggleSeatBot(seat) {
    this._send({ type: 'toggle_bot', seat });
  }

  requestStartMatch() {
    this._send({ type: 'start_match' });
  }

  voteRematch() {
    this._send({ type: 'rematch_vote' });
  }

  leaveRoom() {
    this._send({ type: 'leave_room' });
    this.room = null;
    this.myId = null;
    this.localSeat = 0;
  }

  sendAction(action) {
    this._send({ type: 'action', action });
  }

  sendEmote(emote) {
    this._send({ type: 'emote', emote });
  }
}
