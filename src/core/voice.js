// Voice chat over the same WebRTC peer. The guest places the call once the room connects.

export async function getMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (e) {
    console.warn('[voice] microphone unavailable', e);
    return null;
  }
}

let silentCtx = null;
function silentStream() {
  silentCtx ??= new AudioContext();
  return silentCtx.createMediaStreamDestination().stream;
}

export class Voice {
  constructor(net, mic) {
    this.net = net;
    this.mic = mic;
    this.call = null;
    this.audio = new Audio();
    this.audio.autoplay = true;

    net.peer.on('call', (call) => {
      call.answer(this.mic || silentStream());
      this._wire(call);
    });
    net.on('connect', () => { if (net.role === 'guest') this._call(); });
    net.on('disconnect', () => { this.call?.close(); this.call = null; });
    if (net.connected && net.role === 'guest') this._call();
  }

  _call() {
    if (!this.net.peer || !this.net.remotePeerId) return;
    this._wire(this.net.peer.call(this.net.remotePeerId, this.mic || silentStream()));
  }

  _wire(call) {
    this.call?.close();
    this.call = call;
    call.on('stream', (stream) => {
      this.audio.srcObject = stream;
      this.resume();
    });
  }

  // Browsers only start audio after a user gesture; call this from a click handler too.
  resume() {
    if (this.audio.srcObject) this.audio.play().catch(() => {});
  }

  setMuted(muted) {
    this.mic?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  }
}
