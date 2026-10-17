import * as THREE from 'three';
import { disposeTree } from './env.js';

// Base class for every game/scene. Everything added to `root` (or via attach()) is cleaned up on dispose.
export class Game {
  constructor(app) {
    this.app = app;
    this.root = new THREE.Group();
    app.scene.add(this.root);
    this.attached = [];
  }

  // Add an object under something that outlives the game (rig, avatar hands, grips).
  attach(parent, child) {
    parent.add(child);
    this.attached.push([parent, child]);
    return child;
  }

  update(/* dt, time */) {}
  onNet(/* kind, data */) {}

  dispose() {
    for (const [parent, child] of this.attached) {
      parent.remove(child);
      disposeTree(child);
    }
    this.app.scene.remove(this.root);
    disposeTree(this.root);
  }
}
