/**
 * Stand-in for three.js. `@nous-research/ui`'s utils barrel imports three
 * (an optional peer) only for `hexToVec3`, which this app never calls, and
 * the DS components used here are DOM-only. Aliasing it in vite.config.ts
 * means the app boots whether or not a package manager installed three.
 */
export class Vector3 {
  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
}
