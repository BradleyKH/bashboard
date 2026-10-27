import { fertilityOf, fragilityOf, mutate, randomFounderGenome, type Genome } from './genome';
import { createRng, randomUnitVector, type Rng } from './rng';
import { SpatialHash } from './spatialHash';
import { HUSK_GENERATIONS, SPAWN_TABLE, STAGE_COUNT, STAGES, Stage } from './stages';

export interface Organism {
  id: number;
  /** Sequence number of the founder this organism descends from. */
  lineage: number;
  parentId: number | null;
  /** Generations of descent from the founder. */
  depth: number;
  stage: Stage;
  /** Generations spent in the current stage. */
  stageAge: number;
  age: number;
  /** Died before completing its life cycle (as opposed to dying of old age). */
  perished: boolean;
  genome: Genome;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface SimSettings {
  /** Living population the environment can sustain. */
  capacity: number;
  /** Multiplier on genome mutation size. */
  mutationRate: number;
}

export interface TickResult {
  births: { parent: Organism; child: Organism }[];
  /** Organisms that became husks this generation. */
  deaths: Organism[];
  /** Organisms that dissolved completely and left the simulation. */
  removed: Organism[];
  extinct: boolean;
  newEpoch: boolean;
  blight: Blight | null;
}

export interface Blight {
  x: number;
  y: number;
  z: number;
  radius: number;
  killed: number;
}

export interface LineageTraits {
  /** Multiplier on reproduction success for every organism of the lineage. */
  fertility: number;
  /** Children keep this hue instead of mutating it, so the lineage matches its dashboard swatch. */
  hue: number;
}

export interface Snapshot {
  counts: number[];
  living: number;
}

/** Radius within which neighbors count toward local crowding. */
const CROWD_RADIUS = 4.5;
/** Neighbors within CROWD_RADIUS at which local reproduction stops entirely. */
const LOCAL_CAPACITY = 22;
/** Generations of darkness between an extinction and the next founding spore. */
const REFOUND_DELAY = 6;
const HISTORY_LENGTH = 360;
/** Generations per full tide cycle; capacity swells and recedes over it. */
const TIDE_PERIOD = 260;
const TIDE_STRENGTH = 0.35;
const BLIGHT_CHANCE = 0.006;
const BLIGHT_RADIUS = 11;
const BLIGHT_LETHALITY = 0.75;

export class Simulation {
  organisms: Organism[] = [];
  generation = 0;
  epoch = 1;
  peak = 0;
  readonly history: Snapshot[] = [];
  /** Lineages listed here are blight-immune, scaled in fertility, and hue-pinned. */
  readonly lineageTraits = new Map<number, LineageTraits>();
  settings: SimSettings;

  private nextId = 1;
  private nextLineage = 1;
  private extinctFor = -1;
  private readonly rng: Rng;
  private readonly hash = new SpatialHash<Organism>(CROWD_RADIUS);

  constructor(settings: SimSettings, seed = Date.now()) {
    this.settings = { ...settings };
    this.rng = createRng(seed);
    this.found(0, 0, 0);
    this.record();
  }

  /** Plants a new founder spore with a fresh genome and lineage. */
  found(x: number, y: number, z: number, genome = randomFounderGenome(this.rng)): Organism {
    const o: Organism = {
      id: this.nextId++,
      lineage: this.nextLineage++,
      parentId: null,
      depth: 0,
      stage: Stage.Spore,
      stageAge: 0,
      age: 0,
      perished: false,
      genome,
      x,
      y,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
    };
    this.organisms.push(o);
    this.extinctFor = -1;
    return o;
  }

  reset(): void {
    this.organisms = [];
    this.history.length = 0;
    this.generation = 0;
    this.epoch = 1;
    this.peak = 0;
    this.extinctFor = -1;
    this.nextLineage = 1;
    this.found(0, 0, 0);
    this.record();
  }

  livingCount(): number {
    let n = 0;
    for (const o of this.organisms) if (o.stage !== Stage.Husk) n++;
    return n;
  }

  counts(): number[] {
    const counts = new Array<number>(STAGE_COUNT).fill(0);
    for (const o of this.organisms) counts[o.stage]++;
    return counts;
  }

  tick(): TickResult {
    const result: TickResult = {
      births: [],
      deaths: [],
      removed: [],
      extinct: false,
      newEpoch: false,
      blight: null,
    };
    const living = this.livingCount();
    const globalRoom = Math.max(0, 1 - living / this.effectiveCapacity());
    const blight = living > 60 && this.rng() < BLIGHT_CHANCE ? this.pickBlightSite() : null;
    const blightR2 = BLIGHT_RADIUS * BLIGHT_RADIUS;
    this.hash.rebuild(this.organisms.filter((o) => o.stage !== Stage.Husk));

    const survivors: Organism[] = [];
    const newborn: Organism[] = [];

    for (const o of this.organisms) {
      o.age++;
      o.stageAge++;

      if (o.stage === Stage.Husk) {
        if (o.stageAge >= HUSK_GENERATIONS) result.removed.push(o);
        else survivors.push(o);
        continue;
      }

      const crowding = Math.min(1, this.hash.countNear(o.x, o.y, o.z, CROWD_RADIUS) / LOCAL_CAPACITY);
      // Crowding hurts the prolific more than the hardy, so dense colonies
      // select for hardiness while open frontiers reward fast breeders.
      const deathChance =
        STAGES[o.stage].deathChance * fragilityOf(o.genome) + crowding * crowding * o.genome.strategy * 0.12;

      const traits = this.lineageTraits.get(o.lineage);
      const blighted =
        blight !== null &&
        !traits &&
        (o.x - blight.x) ** 2 + (o.y - blight.y) ** 2 + (o.z - blight.z) ** 2 < blightR2 &&
        this.rng() < BLIGHT_LETHALITY;
      if (blighted) blight.killed++;

      if (blighted || this.rng() < deathChance || o.stage === Stage.Elder) {
        o.perished = o.stage !== Stage.Elder;
        this.becomeHusk(o);
        result.deaths.push(o);
        survivors.push(o);
        continue;
      }

      const spawn = SPAWN_TABLE[o.stage];
      if (spawn) {
        const roll = this.rng();
        const count = spawn.find(([, p]) => roll < p)?.[0] ?? 0;
        const success = fertilityOf(o.genome) * (traits?.fertility ?? 1) * globalRoom * (1 - crowding);
        for (let i = 0; i < count; i++) {
          if (this.rng() >= success) continue;
          const child = this.spawnChild(o);
          newborn.push(child);
          result.births.push({ parent: o, child });
        }
      }

      o.stage = (o.stage + 1) as Stage;
      o.stageAge = 0;
      survivors.push(o);
    }

    this.organisms = survivors.concat(newborn);
    this.generation++;
    result.blight = blight;

    const nowLiving = this.livingCount();
    if (nowLiving === 0) {
      if (this.extinctFor < 0) {
        this.extinctFor = 0;
        result.extinct = true;
      } else if (++this.extinctFor >= REFOUND_DELAY) {
        this.epoch++;
        this.generation = 0;
        this.history.length = 0;
        this.found(0, 0, 0);
        result.newEpoch = true;
      }
    }

    this.peak = Math.max(this.peak, this.livingCount());
    this.record();
    return result;
  }

  /** Carrying capacity after the tide, which swells and recedes over TIDE_PERIOD generations. */
  effectiveCapacity(): number {
    return this.settings.capacity * (1 + TIDE_STRENGTH * Math.sin((this.generation / TIDE_PERIOD) * Math.PI * 2));
  }

  /** Tide level from 0 (lowest ebb) to 1 (highest flood). */
  tideLevel(): number {
    return 0.5 + 0.5 * Math.sin((this.generation / TIDE_PERIOD) * Math.PI * 2);
  }

  tideRising(): boolean {
    return Math.cos((this.generation / TIDE_PERIOD) * Math.PI * 2) > 0;
  }

  meanStrategy(): number {
    let sum = 0;
    let n = 0;
    for (const o of this.organisms) {
      if (o.stage === Stage.Husk) continue;
      sum += o.genome.strategy;
      n++;
    }
    return n ? sum / n : 0;
  }

  maxDepth(): number {
    let max = 0;
    for (const o of this.organisms) if (o.stage !== Stage.Husk && o.depth > max) max = o.depth;
    return max;
  }

  private pickBlightSite(): Blight | null {
    const living = this.organisms.filter((o) => o.stage !== Stage.Husk && !this.lineageTraits.has(o.lineage));
    const origin = living[Math.floor(this.rng() * living.length)];
    return origin ? { x: origin.x, y: origin.y, z: origin.z, radius: BLIGHT_RADIUS, killed: 0 } : null;
  }

  private becomeHusk(o: Organism): void {
    o.stage = Stage.Husk;
    o.stageAge = 0;
  }

  private spawnChild(parent: Organism): Organism {
    const [dx, dy, dz] = randomUnitVector(this.rng);
    const dist = 1.2 + this.rng() * 1.8;
    const kick = 2.5 + this.rng() * 2.5;
    const genome = mutate(parent.genome, this.settings.mutationRate, this.rng);
    const traits = this.lineageTraits.get(parent.lineage);
    if (traits) genome.hue = traits.hue;
    return {
      id: this.nextId++,
      lineage: parent.lineage,
      parentId: parent.id,
      depth: parent.depth + 1,
      stage: Stage.Spore,
      stageAge: 0,
      age: 0,
      perished: false,
      genome,
      x: parent.x + dx * dist,
      y: parent.y + dy * dist,
      z: parent.z + dz * dist,
      vx: dx * kick,
      vy: dy * kick,
      vz: dz * kick,
    };
  }

  private record(): void {
    const counts = this.counts();
    this.history.push({ counts, living: counts.reduce((a, b) => a + b, 0) - counts[Stage.Husk] });
    if (this.history.length > HISTORY_LENGTH) this.history.shift();
  }
}
