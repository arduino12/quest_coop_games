import * as THREE from 'three';
import { Game } from '../core/game.js';
import { Panel, Label } from '../core/ui3d.js';
import { starfield, gridFloor, glowMat, edges } from '../core/env.js';
import { COLORS } from '../config.js';

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
      w: 1.5, h: 1.15, title: 'Pick a game',
      lines: [
        'Point a controller at a button and pull the trigger. Either player can pick.',
        'In any game: hold B or Y for one second to come back here.',
      ],
      buttons: [
        { label: 'Neon Handball   ·   1 vs 1', onClick: () => app.requestGame('handball') },
        { label: 'Fort Siege   ·   1 vs 1', onClick: () => app.requestGame('fortsiege'), accent: '#ffb347' },
        { label: 'Starship Bridge   ·   co-op', onClick: () => app.requestGame('starship'), accent: '#7dff8a' },
      ],
    }));
    this.panel.mesh.position.set(0, 1.45, -1.6);
    root.add(this.panel.mesh);

    this.status = new Label('', { w: 1.5, h: 0.12, res: 1024, size: 0.55, color: '#9fb4ff' });
    this.status.mesh.position.set(0, 2.15, -1.6);
    root.add(this.status.mesh);

    // Spinning icons for each game.
    this.icons = [];
    const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), glowMat(COLORS.host));
    ball.add(edges(new THREE.IcosahedronGeometry(0.22, 1), 0xffffff, 0.5));
    const fort = new THREE.Group();
    const brick = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    const brickMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
    for (const [bx, by] of [[-0.13, 0], [0, 0], [0.13, 0], [-0.065, 0.13], [0.065, 0.13], [0, 0.26]]) {
      const b = new THREE.Mesh(brick, brickMat);
      b.position.set(bx, by - 0.1, 0);
      fort.add(b);
    }
    const ship = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.4, 6), glowMat(0x7dff8a));
    hull.rotation.x = -Math.PI / 2;
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.02, 0.12), glowMat(0x7dff8a));
    wing.position.z = 0.08;
    ship.add(hull, wing);
    [ball, fort, ship].forEach((o, i) => {
      o.position.set(-1.25 + i * 1.25, 2.55, -2.0);
      root.add(o);
      this.icons.push(o);
    });

    this.statusTimer = 0;
  }

  update(dt, t) {
    this.icons.forEach((o, i) => {
      o.rotation.y = t * 0.8 + i;
      o.position.y = 2.55 + Math.sin(t * 1.5 + i) * 0.05;
    });
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
