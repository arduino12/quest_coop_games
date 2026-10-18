import * as THREE from 'three';
import { Game } from '../core/game.js';
import { Panel, Label } from '../core/ui3d.js';
import { starfield, gridFloor, glowMat } from '../core/env.js';
import { MENU } from './menu.js';

// The menu room: both players stand side by side and either one picks a game.
export class Lobby extends Game {
  constructor(app) {
    super(app);
    const root = this.root;
    app.scene.background = new THREE.Color(0x03030c);
    app.scene.fog = new THREE.Fog(0x03030c, 8, 40);
    root.add(starfield(1200));
    root.add(gridFloor(30, 30, 0x2a3a8a, 0.35));
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 2.7, 64), glowMat(0x4466ff, 0.6));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    root.add(ring);

    const x = app.role === 'guest' ? 0.55 : app.net.connected ? -0.55 : 0;
    app.setRig(x, 0, 0.3, 0);

    this.panel = app.ui.add(new Panel({
      w: 1.9, h: 1.45, res: 1024, cols: 2, title: 'Pick a game',
      lines: [
        'Point a controller at a game and pull the trigger. Either player can pick.',
        'In any game: hold B or Y for one second to come back here.',
      ],
      buttons: MENU.map((g) => ({ label: g.label, accent: g.accent, onClick: () => app.requestGame(g.id) })),
    }));
    this.panel.mesh.position.set(0, 1.45, -1.7);
    root.add(this.panel.mesh);

    this.status = new Label('', { w: 1.6, h: 0.12, res: 1024, size: 0.55, color: '#9fb4ff' });
    this.status.mesh.position.set(0, 2.32, -1.7);
    root.add(this.status.mesh);
    this.statusTimer = 0;
  }

  update(dt) {
    this.statusTimer -= dt;
    if (this.statusTimer > 0) return;
    this.statusTimer = 0.5;
    const net = this.app.net;
    let s;
    if (net.role === 'solo') s = 'Solo practice';
    else if (!net.connected) s = `Room ${net.code}  ·  waiting for your friend to join…`;
    else s = `Room ${net.code}  ·  partner connected  ·  ping ${Math.round(net.rtt)} ms`;
    this.status.set(s);
  }
}
