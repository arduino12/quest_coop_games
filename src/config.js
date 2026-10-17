// Room ids on the PeerJS broker are ROOM_PREFIX + 4-letter code.
export const ROOM_PREFIX = 'quest-coop-games-v1-';

// STUN lets the two headsets find a direct path through home routers.
// If joining keeps timing out between two homes, one of the networks needs a TURN relay:
// create a free account (e.g. metered.ca "Open Relay") and add its entry here, like:
// { urls: 'turn:global.relay.metered.ca:80', username: 'xxx', credential: 'yyy' },
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export const POSE_HZ = 30;
export const INTERP_DELAY_MS = 100;

export const COLORS = {
  host: 0x22e6ff,
  guest: 0xff3df0,
};

export const CSS_COLORS = {
  host: '#22e6ff',
  guest: '#ff3df0',
};
