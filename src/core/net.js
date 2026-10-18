import { Peer } from 'peerjs';
import { ROOM_PREFIX, ICE_SERVERS } from '../config.js';

const JOIN_TIMEOUT_MS = 15000;

// Two-player room over WebRTC (PeerJS). The room creator is the host.
// Two data channels: 'evt' (reliable, ordered) for game events and 'state' (unreliable) for
// high-rate poses/snapshots. Messages are { t: type, d: data, ts: sender performance.now() }.
export class Net {
  constructor() {
    this.role = 'solo'; // 'host' | 'guest' | 'solo'
    this.peer = null;
    this.evt = null;
    this.state = null;
    this.connected = false;
    this.code = null;
    this.remotePeerId = null;
    this.rtt = 0;
    this.handlers = new Map();
    this.pingTimer = null;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  emit(type, ...args) {
    for (const fn of this.handlers.get(type) || []) {
      try { fn(...args); } catch (e) { console.error(`[net] handler "${type}" failed`, e); }
    }
  }

  _newPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(id, { config: { iceServers: ICE_SERVERS }, debug: 1 });
      const fail = (err) => { peer.destroy(); reject(err); };
      peer.once('open', () => { peer.off('error', fail); resolve(peer); });
      peer.once('error', fail);
    });
  }

  async host(code) {
    this.peer = await this._newPeer(ROOM_PREFIX + code);
    this.role = 'host';
    this.code = code;
    this.peer.on('connection', (conn) => this._onIncoming(conn));
    this.peer.on('error', (e) => this.emit('error', e));
    // Losing the broker doesn't drop an existing game, but reconnect so a friend can (re)join.
    this.peer.on('disconnected', () => { if (!this.peer.destroyed) this.peer.reconnect(); });
    this._startPing();
  }

  _onIncoming(conn) {
    const slot = conn.label === 'state' ? 'state' : 'evt';
    const current = this[slot];
    if (current && current.open && current.peer !== conn.peer) {
      conn.on('open', () => conn.close()); // room already has a guest
      return;
    }
    this[slot] = conn;
    this.remotePeerId = conn.peer;
    this._wire(conn);
  }

  async join(code) {
    this.peer = await this._newPeer(undefined);
    this.code = code;
    const hostId = ROOM_PREFIX + code;
    this.remotePeerId = hostId;

    await new Promise((resolve, reject) => {
      let opened = 0;
      const timer = setTimeout(() => reject(new Error(
        'Timed out connecting. Check the code. If it keeps failing between two homes, a TURN relay is needed (see config.js).',
      )), JOIN_TIMEOUT_MS);
      const onPeerError = (e) => {
        clearTimeout(timer);
        reject(e.type === 'peer-unavailable' ? new Error(`No room with code ${code}.`) : e);
      };
      this.peer.once('error', onPeerError);
      const open = (label, reliable) => {
        const c = this.peer.connect(hostId, { label, reliable, serialization: 'json' });
        this[label] = c;
        c.once('open', () => {
          if (++opened === 2) {
            clearTimeout(timer);
            this.peer.off('error', onPeerError);
            resolve();
          }
        });
      };
      open('evt', true);
      open('state', false);
    });

    this.role = 'guest';
    this._wire(this.evt);
    this._wire(this.state);
    this.peer.on('error', (e) => this.emit('error', e));
    this._startPing();
    this._checkConnected();
  }

  _wire(conn) {
    conn.on('data', (msg) => this._onData(msg));
    conn.on('close', () => this._onClose(conn));
    conn.on('error', (e) => console.warn('[net] connection error', e));
    if (conn.open) this._checkConnected();
    else conn.on('open', () => this._checkConnected());
  }

  _checkConnected() {
    if (!this.connected && this.evt?.open && this.state?.open) {
      this.connected = true;
      this.emit('connect');
    }
  }

  _onClose(conn) {
    if (conn !== this.evt && conn !== this.state) return;
    const wasConnected = this.connected;
    this.connected = false;
    if (this.evt && this.evt !== conn) this.evt.close();
    if (this.state && this.state !== conn) this.state.close();
    this.evt = null;
    this.state = null;
    if (this.role === 'guest') this.role = 'solo';
    if (wasConnected) this.emit('disconnect');
  }

  _onData(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (msg.t === 'ping') { this.send('pong', { t: msg.d.t }); return; }
    if (msg.t === 'pong') {
      const sample = performance.now() - msg.d.t;
      this.rtt = this.rtt ? this.rtt * 0.8 + sample * 0.2 : sample;
      return;
    }
    this.emit(msg.t, msg.d, msg.ts);
  }

  _startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.connected) this.send('ping', { t: performance.now() });
    }, 2000);
  }

  destroy() {
    clearInterval(this.pingTimer);
    try { this.peer?.destroy(); } catch { /* already gone */ }
    this.peer = null;
    this.connected = false;
  }

  // reliable=false sends on the unreliable channel (falls back to reliable if needed).
  // (LoopbackNet below overrides this.)
  send(t, d, reliable = true) {
    const c = reliable ? this.evt : (this.state?.open ? this.state : this.evt);
    if (!c || !c.open) return false;
    try {
      c.send({ t, d, ts: performance.now() });
      return true;
    } catch (e) {
      console.warn('[net] send failed', t, e);
      return false;
    }
  }
}

// Dev-only transport (?loop): tabs or iframes of the same browser talk over a BroadcastChannel.
// Lets duo.html test the games on a PC whose network blocks peer-to-peer (e.g. a VPN). No voice.
export class LoopbackNet extends Net {
  async host(code) {
    this.id = 'host';
    this.code = code;
    this.role = 'host';
    this._open(code);
    this._startPing();
  }

  async join(code) {
    this.id = `guest-${Math.random().toString(36).slice(2)}`;
    this.code = code;
    this._open(code);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No room with code ${code}.`)), 5000);
      this._onWelcome = () => { clearTimeout(timer); resolve(); };
      this.ch.postMessage({ from: this.id, sys: 'join' });
    });
    this.role = 'guest';
    this._startPing();
    this.connected = true;
    this.emit('connect');
  }

  _open(code) {
    this.ch = new BroadcastChannel(`qcg-loop-${code}`);
    this.ch.onmessage = (e) => {
      const m = e.data;
      if (m.from === this.id) return;
      if (m.sys === 'join' && this.role === 'host') {
        this.ch.postMessage({ from: this.id, sys: 'welcome', to: m.from });
        if (!this.connected) { this.connected = true; this.emit('connect'); }
      } else if (m.sys === 'welcome' && m.to === this.id) this._onWelcome?.();
      else if (m.sys === 'bye' && this.connected) {
        this.connected = false;
        if (this.role === 'guest') this.role = 'solo';
        this.emit('disconnect');
      } else if (m.msg) this._onData(m.msg);
    };
    window.addEventListener('beforeunload', () => this.ch.postMessage({ from: this.id, sys: 'bye' }));
  }

  send(t, d) {
    if (!this.connected) return false;
    this.ch.postMessage({ from: this.id, msg: { t, d, ts: performance.now() } });
    return true;
  }

  destroy() {
    clearInterval(this.pingTimer);
    this.ch?.close();
    this.connected = false;
  }
}
