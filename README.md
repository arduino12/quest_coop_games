# Quest Co-op Games

Three VR games for **two Meta Quest headsets playing together over the internet**, built as a
WebXR web page: no app install, no store, no developer fees. Each player opens the same link in
the Quest Browser.

| Game | Mode | In one line |
|---|---|---|
| **Neon Handball** | 1 vs 1 | Smack a glowing ball down a neon tunnel with your hands. First to 7. |
| **Laser Fencing** | 1 vs 1 | Sword in your right hand, shield in your left. First to 5 touches. |
| **Zero-G Dodgeball** | 1 vs 1 | Float in a cube, pull yourself along the walls, throw balls. First to 7 hits. |
| **Climbing Race** | 1 vs 1 | Race up side-by-side walls to the bell; drop rocks on your rival. |
| **Rhythm Battle** | 1 vs 1 | Punch notes to a generated beat; big combos send extra notes to your rival. |
| **Bomb Squad** | co-op | One defuses a bomb, the other has the manual, in separate rooms. Talk! |
| **Pizza Rush** | co-op | Orders pour in: stretch dough, sauce, top, bake and serve, with a friend or the robot helper. |
| **Bullet Time** | co-op | Time only moves when you move. Shoot, punch and throw your way through the red enemies. |
| **Face Lab** | solo | See your own 3D face scan: size, turn, nod, tilt, auto-spin, a body, and a mirror that copies you. |
| **Fort Siege** | 1 vs 1 | 3 minutes to build a fort around your crystal, then a slingshot duel. |
| **Starship Bridge** | co-op | Fly anywhere in a 360° sector, follow the map to enemy outposts and destroy them through mines and fighters. |

Every game also works solo for practice.

## How to play

1. One player opens the site, presses **Create a room** and sends the 4-letter code (or the invite link) to the other.
2. The other player types the code and presses **Join**.
3. Both press **Enter VR**. In the menu room, point at a game and pull the trigger.
4. In any game, **hold B or Y for one second** to go back to the menu.
5. **Leave room** in the menu takes you back to the create/join page.

Voice chat is built in (allow the microphone when asked).

### Controls

- **Neon Handball:** your hands are the paddles; swing at the ball. Press A / X (or use the panel beside you) to switch between a sphere and a cube paddle; the cube turns with your wrist and gives cleaner angles. The play space floats between hip and head height, so every ball is reachable. The left stick slides you around your end.
- **Laser Fencing:** your own headset judges hits on you, so blocks you see are blocks that count. A touch needs a real swing; slow pokes don't score. Solo: slash orbs for 60 seconds.
- **Zero-G Dodgeball:** squeeze near any wall or pillar to grab it and pull yourself; let go to drift. Left stick = gentle thrusters. Squeeze near a ball to grab it, swing and let go to throw. Only direct hits count.
- **Climbing Race:** squeeze to grip a hold and pull yourself up. Let go of everything and you fall to the last ledge. Rocks fall from the top; the red button on each ledge drops 3 rocks on your rival. Ring the bell first.
- **Rhythm Battle:** blue notes = left hand, pink = right; punch them as they reach the rings. The lanes fit your height when the song starts. Every 16 combo sends yellow attack notes to your rival.
- **Bomb Squad:** the defuser points and pulls the trigger to cut wires, press keys, hold the button and spin the password letters. The expert flips manual pages with the buttons under it. Three strikes and it explodes. Solo: the manual hangs on the wall to your right.
- **Pizza Rush:** read the tickets above the counter (size, dough, sauce, cheese, toppings). Grip a dough ball (left), put your second hand on it and pull apart until the size ring says S / M / L. Hold a sauce bottle over it and pull the trigger, drop cheese and toppings on it, bake it in the oven (right) until it says READY, and put it on the green SERVE spot. Burnt or wrong pizzas cost points; fast ones earn tips. The robot helper (on in solo, optional with a friend) preps dough and serves pizzas from the oven.
- **Bullet Time:** time runs at about 5% while you stand still and speeds up as you move. Grip the gun floating in front of you; the trigger fires (6 shots). Throw the empty gun at an enemy (a new one appears after a moment), or punch them. Enemy bullets leave trails; dodge them. If either player is hit, the level restarts.
- **Fort Siege:**
  - *Build phase:* squeeze the grip on the shelf to your left to take a block, then release to drop or throw it. Blocks snap straight when released almost level. Left stick moves you, right stick turns.
  - *Battle phase:* squeeze the slingshot pouch, pull back (the dotted arc shows where it lands), and let go.
- **Starship Bridge:** each level is a sector with enemy outposts to destroy. The holographic map
  in front of you shows outposts (the current target in yellow), fighters and nearby mines, and the
  yellow arrow above it points to the target.
  - *Pilot:* grab the joystick, or use the left thumbstick, to turn and climb (all the way round).
    Grab the throttle lever, or use the right thumbstick, to set speed. The trigger on the joystick
    hand fires the nose guns.
  - *Gunner:* aim with your hands and pull the triggers. Shoot mines before you fly into them;
    pink mines chase you.
  - *Everyone:* hold the grip on a sparking red panel for about a second to fix it.
  - Sitting still is deadly: turrets and fighters lead their shots.

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
  It links them inside the browser (`?loop`), so it also works on a PC whose VPN blocks peer-to-peer.

## Your face in VR (Face Lab)

Face scans stay private: they are never committed to this repository or put on the website.

1. **Convert the scan on the PC** (OBJ + MTL + texture, e.g. from EXStar) into a light model for the Quest:
   ```bash
   npm run face -- "C:\Users\you\Documents\EXStar\arad01.obj"
   ```
   This writes `faces/arad01.glb` (about 1.3 MB, 50k triangles). `faces/` is ignored by git.
2. **Copy the .glb to the Quest** (for example with SideQuest, or `adb push faces/arad01.glb /sdcard/Download/`).
3. On the start page in the Quest Browser, press **Choose face file** and pick it. It is stored in the headset's
   browser only.
4. In VR open **Face Lab**: size, turn, nod, tilt, height, auto-spin, body on/off, and **Mirror** mode, where the
   scan becomes the head of a body that copies your movements. **Save** keeps that setup for your avatar.

On the PC, `?face=/faces/arad01.glb` loads a converted scan straight from the dev server.

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
