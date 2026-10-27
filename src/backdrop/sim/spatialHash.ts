export interface Positioned {
  x: number;
  y: number;
  z: number;
}

/** Uniform grid for neighbor queries; cells are reused between rebuilds. */
export class SpatialHash<T extends Positioned> {
  private readonly cells = new Map<number, T[]>();

  constructor(readonly cellSize: number) {}

  rebuild(items: Iterable<T>): void {
    for (const cell of this.cells.values()) cell.length = 0;
    for (const item of items) {
      const k = this.key(this.index(item.x), this.index(item.y), this.index(item.z));
      let cell = this.cells.get(k);
      if (!cell) {
        cell = [];
        this.cells.set(k, cell);
      }
      cell.push(item);
    }
  }

  /** Visits every item in the 27 cells around (x, y, z); callers filter by exact distance. */
  forEachNear(x: number, y: number, z: number, visit: (item: T) => void): void {
    const ix = this.index(x);
    const iy = this.index(y);
    const iz = this.index(z);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cell = this.cells.get(this.key(ix + dx, iy + dy, iz + dz));
          if (cell) for (let i = 0; i < cell.length; i++) visit(cell[i]);
        }
      }
    }
  }

  countNear(x: number, y: number, z: number, radius: number): number {
    const r2 = radius * radius;
    let n = 0;
    this.forEachNear(x, y, z, (o) => {
      const dx = o.x - x;
      const dy = o.y - y;
      const dz = o.z - z;
      if (dx * dx + dy * dy + dz * dz < r2) n++;
    });
    return n;
  }

  private index(v: number): number {
    return Math.floor(v / this.cellSize);
  }

  private key(ix: number, iy: number, iz: number): number {
    return ((ix + 512) * 1024 + (iy + 512)) * 1024 + (iz + 512);
  }
}
