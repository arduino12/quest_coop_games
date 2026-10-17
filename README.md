# Quest Co-op Games

Three VR games for **two Meta Quest headsets playing together over the internet**, built as a
WebXR web page: no app install, no store, no developer fees. Each player opens the same link in
the Quest Browser.

| Game | Mode | In one line |
|---|---|---|
| **Neon Handball** | 1 vs 1 | Smack a glowing ball down a neon tunnel with your hands. First to 7. |
| **Fort Siege** | 1 vs 1 | 3 minutes to build a fort around your crystal, then a slingshot duel. |
| **Starship Bridge** | co-op | One pilots, one shoots, both patch hull breaches. Survive the waves. |

Every game also works solo for practice.

## How to play

1. One player opens the site, presses **Create a room** and sends the 4-letter code (or the invite link) to the other.
2. The other player types the code and presses **Join**.
3. Both press **Enter VR**. In the menu room, point at a game and pull the trigger.
4. In any game, **hold B or Y for one second** to go back to the menu.

Voice chat is built in (allow the microphone when asked).

### Controls

- **Neon Handball:** your hands are the paddles; swing at the ball. The left stick slides you around your end.
- **Fort Siege:**
  - *Build phase:* squeeze the grip on the shelf to your left to take a block, then release to drop or throw it. Blocks snap straight when released almost level. Left stick moves you, right stick turns.
  - *Battle phase:* squeeze the slingshot pouch, pull back (the dotted arc shows where it lands), and let go.
- **Starship Bridge:**
  - *Pilot:* grab the joystick, or use the left thumbstick, to dodge.
  - *Gunner:* aim with your hands and pull the triggers.
  - *Everyone:* hold the grip on a sparking red panel for about a second to fix it.

## Running it

### On the headsets (to play with a friend in another home)

The page must be served over HTTPS for WebXR. The free way is GitHub Pages:

1. Create a GitHub repository and push this project to it.
2. In the repo: **Settings → Pages → Source: GitHub Actions**.
3. Every push to `main` builds and publishes the site (see `.github/workflows/deploy.yml`).
   The address is `https://<your-user>.github.io/<repo-name>/`.

### Quick test on your own Quest (same Wi-Fi)

```bash
npm install
npm run dev:https
```

Open `https://<your-PC's-IP>:5173` in the Quest Browser and accept the certificate warning
(the certificate is self-signed).

Or, with the headset on USB and `adb` available (SideQuest ships one): run `npm run dev`, then
`adb reverse tcp:5173 tcp:5173`, and open `http://localhost:5173` on the Quest.

### On a PC, without a headset

- `http://localhost:5173/?emu` emulates a Quest 2 in the browser, using Meta's Immersive Web Emulator.
- `http://localhost:5173/duo.html` opens a host and a guest side by side, already connected (for development).

## How it works

- **Three.js** for rendering and WebXR, **Rapier** (WASM) for Fort Siege physics, and **PeerJS** (WebRTC) for
  networking. The headsets connect directly peer-to-peer; the free public PeerJS server is only
  used to introduce them.
- The room creator is the **host**. Each game picks who decides what:
  - *Handball:* whoever's half the ball is in owns it, so your own hits never lag.
  - *Fort Siege:* each player simulates their own island while building; the host simulates the battle.
  - *Starship:* the pilot owns the ship's position. The host runs enemies, damage and score. Each shooter reports their own hits.
- Remote movement is smoothed with 100 ms snapshot interpolation (`src/core/sync.js`).

### If joining fails between two homes

Some home or mobile networks block direct connections. Add a TURN relay in `src/config.js`:
create a free account (e.g. metered.ca "Open Relay") and paste its server entry there.

## Development

```bash
npm install
npm run dev     # dev server on http://localhost:5173
npm test        # unit tests (game rules, physics helpers, netcode smoothing)
npm run build   # production build into dist/
```

```
src/
  main.js            landing page: create / join / solo, Enter VR
  config.js          STUN/TURN servers, colors, network rates
  core/              app loop, input, 3D panels, avatars, voice, sound, sync helpers
  games/lobby.js     menu room
  games/handball/    logic.js (pure rules) + handball.js (scene + netcode)
  games/fortsiege/   logic.js + fortsiege.js
  games/starship/    logic.js + starship.js
tests/               vitest unit tests for the logic modules
```
