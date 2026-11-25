export class LudoNetworkClient {
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.clientId = `l_${Math.random().toString(36).slice(2, 10)}`;
    this.room = null;
    this.localSeat = 0;
    this.isConnected = false;
    this._connect();
  }

  _connect() {
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${proto}//${window.location.host}/ws`);

      this.ws.addEventListener('open', () => {
        this.isConnected = true;
        this.handlers.onConnectionChange?.(true);
      });

      this.ws.addEventListener('message', (ev) => {
        try {
          const data = JSON.parse(ev.data);
          this._onMessage(data);
        } catch (_) {
          // ignore
        }
      });

      this.ws.addEventListener('close', () => {
        this.isConnected = false;
        this.handlers.onConnectionChange?.(false);
        setTimeout(() => this._connect(), 2500);
      });
    } catch (_) {
      this.isConnected = false;
    }
  }

  _onMessage(data) {
    switch (data.type) {
      case 'welcome':
        this.clientId = data.clientId;
        if (typeof data.onlineCount === 'number') {
          this.handlers.onOnlineCount?.(data.onlineCount);
        }
        break;
      case 'online_count':
        this.handlers.onOnlineCount?.(data.count);
        break;
      case 'room_joined':
        this.clientId = data.clientId || this.clientId;
        this.localSeat = data.seat;
        this.room = data.room;
        this.handlers.onRoomJoined?.(this.room, this.localSeat, data.lastState);
        break;
      case 'room_updated':
        this.room = data.room;
        const me = this.room.players.find((p) => p.id === this.clientId);
        if (me) this.localSeat = me.seat;
        this.handlers.onRoomUpdated?.(this.room, this.localSeat);
        break;
      case 'room_error':
        this.handlers.onRoomError?.(data.message);
        break;
      case 'match_started':
        this.room = data.room;
        this.handlers.onMatchStarted?.(this.room, this.localSeat);
        break;
      case 'game_state_sync':
        this.handlers.onGameStateSync?.(data.state, data.event);
        break;
      case 'remote_player_action':
        this.handlers.onRemotePlayerAction?.(data.seat, data.action);
        break;
      case 'room_emote':
        this.handlers.onRoomEmote?.(data.seat, data.playerName, data.emote);
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
    return !this.room || this.room.hostId === this.clientId;
  }

  createRoom(roomName, playerName) {
    this._send({ type: 'create_room', roomName, playerName });
  }

  joinRoom(roomCode, playerName) {
    this._send({ type: 'join_room', roomCode, playerName });
  }

  toggleSeatBot(seat) {
    if (this.isHost()) this._send({ type: 'admin_toggle_seat_bot', seat });
  }

  requestAdminStartMatch() {
    if (this.isHost()) this._send({ type: 'host_start_match' });
  }

  leaveRoom() {
    this._send({ type: 'leave_room' });
    this.room = null;
    this.localSeat = 0;
  }

  syncStateFromHost(state, event = null) {
    if (this.isInRoom() && this.isHost()) {
      this._send({ type: 'game_state_sync', state, event });
    }
  }

  sendGuestAction(action) {
    if (this.isInRoom()) {
      this._send({ type: 'remote_player_action', seat: this.localSeat, action });
    }
  }

  sendEmote(playerName, emote) {
    if (this.isInRoom()) {
      this._send({ type: 'room_emote', seat: this.localSeat, playerName, emote });
    }
  }
}
