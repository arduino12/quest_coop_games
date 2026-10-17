import RAPIER from '@dimforge/rapier3d-compat';
import { Net } from './core/net.js';
import { App } from './core/app.js';
import { Sfx } from './core/audio.js';
import { getMic, Voice } from './core/voice.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

// ?emu turns a desktop browser into an emulated Quest 2 (Meta's Immersive Web Emulator).
if (params.has('emu')) {
  const { XRDevice, metaQuest2 } = await import('iwer');
  const device = new XRDevice(metaQuest2);
  device.installRuntime({ forceInstall: true });
  window.__xr = device;
}

const physicsReady = RAPIER.init();
const sfx = new Sfx();
let net = new Net();
let app = null;
let voice = null;
let mic = null;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function busy(b) {
  for (const id of ['btn-create', 'btn-join', 'btn-solo']) $(id).disabled = b;
}

function fail(e) {
  console.error(e);
  setStatus(e?.message || String(e), true);
  busy(false);
}

function inviteLink(code) {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', code);
  return url.toString();
}

function updateRoomInfo() {
  const info = $('room-info');
  if (net.role === 'solo' && !net.code) {
    info.innerHTML = '<div class="peer">Solo practice</div>';
    return;
  }
  const peer = net.connected
    ? '<div class="peer ok">Friend connected ✓</div>'
    : `<div class="peer">${net.role === 'host' ? 'Waiting for your friend to join…' : 'Disconnected'}</div>`;
  if (net.role === 'host') {
    info.innerHTML = `<div>Room code</div><div class="code">${net.code}</div>
      <div class="link">Invite link: ${inviteLink(net.code)}</div>${peer}`;
  } else {
    info.innerHTML = `<div>Joined room</div><div class="code">${net.code}</div>${peer}`;
  }
}

function showReady() {
  $('step-room').hidden = true;
  $('step-ready').hidden = false;
  setStatus('');
  updateRoomInfo();
}

async function startApp() {
  await physicsReady;
  app = new App(net, sfx);
  app.onSessionEnd = () => $('overlay').classList.remove('hidden');
  window.app = app; // handy for debugging from the console
  net.on('connect', updateRoomInfo);
  net.on('disconnect', updateRoomInfo);
}

async function prepareMic() {
  if (!$('chk-voice').checked || mic) return;
  setStatus('Allow the microphone for voice chat…');
  mic = await getMic();
}

async function create() {
  busy(true);
  try {
    await prepareMic();
    setStatus('Creating room…');
    let lastErr = null;
    for (let i = 0; i < 4; i++) {
      try {
        await net.host(makeCode());
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        net.destroy();
        net = new Net();
        if (e.type !== 'unavailable-id') break;
      }
    }
    if (lastErr) throw lastErr;
    voice = new Voice(net, mic);
    await startApp();
    showReady();
  } catch (e) {
    fail(e);
  }
}

async function join(code) {
  busy(true);
  try {
    code = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error('Enter the 4-letter room code.');
    await prepareMic();
    setStatus(`Joining room ${code}…`);
    await net.join(code);
    voice = new Voice(net, mic);
    await startApp();
    showReady();
  } catch (e) {
    net.destroy();
    net = new Net();
    fail(e);
  }
}

async function solo() {
  busy(true);
  net.role = 'solo';
  await startApp();
  showReady();
}

async function enterVR() {
  sfx.unlock();
  voice?.resume();
  try {
    const ok = await app.enterVR();
    $('overlay').classList.add('hidden');
    if (!ok) setStatus('No VR headset found: showing the desktop view. Drag to look around, Esc for this menu.');
  } catch (e) {
    fail(e);
  }
}

document.addEventListener('pointerdown', () => sfx.unlock());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && app && !app.renderer.xr.isPresenting) $('overlay').classList.toggle('hidden');
});

$('btn-create').onclick = create;
$('btn-join').onclick = () => join($('inp-code').value);
$('inp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join($('inp-code').value); });
$('btn-solo').onclick = solo;
$('btn-vr').onclick = enterVR;
$('btn-leave').onclick = () => {
  const url = new URL(location.href);
  url.searchParams.delete('room');
  url.searchParams.delete('auto');
  location.href = url.toString();
};

if (params.get('voice') === '0') $('chk-voice').checked = false;
const room = params.get('room');
if (room) {
  $('inp-code').value = room.toUpperCase();
  setStatus(`Invited to room ${room.toUpperCase()}: press Join.`);
}
// ?auto: skip the clicks (used for automated testing).
if (params.has('auto')) {
  if (room) join(room);
  else if (params.has('host')) create();
  else if (params.has('solo')) solo();
}
