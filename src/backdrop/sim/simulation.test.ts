import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';
import { HUSK_GENERATIONS, Stage } from './stages';

const settings = { capacity: 800, mutationRate: 1 };

describe('Simulation', () => {
  it('starts from a single founding spore, like the original', () => {
    const sim = new Simulation(settings, 1);
    expect(sim.organisms).toHaveLength(1);
    expect(sim.organisms[0].stage).toBe(Stage.Spore);
    expect(sim.generation).toBe(0);
  });

  it('advances survivors one stage per generation', () => {
    const sim = new Simulation(settings, 7);
    const founder = sim.organisms[0];
    sim.tick();
    expect([Stage.Larva, Stage.Husk]).toContain(founder.stage);
  });

  it('dissolves husks after they linger', () => {
    const sim = new Simulation(settings, 3);
    const founder = sim.organisms[0];
    founder.stage = Stage.Elder;
    sim.tick();
    expect(founder.stage).toBe(Stage.Husk);
    for (let i = 0; i < HUSK_GENERATIONS; i++) sim.tick();
    expect(sim.organisms).not.toContain(founder);
  });

  it('never grows far past its carrying capacity', () => {
    for (const seed of [11]) {
      const sim = new Simulation(settings, seed);
      for (let i = 0; i < 400; i++) sim.tick();
      // Tides can lift capacity by up to 35%.
      expect(sim.peak).toBeLessThanOrEqual(settings.capacity * 1.5);
    }
  });

  it('usually establishes a thriving population', () => {
    let thriving = 0;
    for (let seed = 100; seed < 108; seed++) {
      const sim = new Simulation(settings, seed);
      for (let i = 0; i < 120; i++) sim.tick();
      if (sim.peak > settings.capacity * 0.3) thriving++;
    }
    expect(thriving).toBeGreaterThan(5);
  });

  it('refounds a new epoch after extinction', () => {
    const sim = new Simulation(settings, 5);
    sim.organisms = [];
    const first = sim.tick();
    expect(first.extinct).toBe(true);
    let refounded = false;
    for (let i = 0; i < 10 && !refounded; i++) refounded = sim.tick().newEpoch;
    expect(refounded).toBe(true);
    expect(sim.epoch).toBe(2);
    expect(sim.organisms.some((o) => o.stage === Stage.Spore && o.parentId === null)).toBe(true);
  });

  describe('background reseeding', () => {
    const backgroundFounders = (sim: Simulation): number =>
      sim.organisms.filter((o) => o.parentId === null && !sim.lineageTraits.has(o.lineage)).length;

    it('replants the background beside a living session lineage, without a new epoch', () => {
      const sim = new Simulation(settings, 9);
      sim.organisms = [];
      const session = sim.found(3, 0, 0);
      sim.lineageTraits.set(session.lineage, { fertility: 0, hue: 0.5 });
      // Keep the session lineage alive however its rolls go, as SessionColony does.
      session.stage = Stage.Larva;
      let planted = false;
      for (let i = 0; i < 8 && !planted; i++) {
        const result = sim.tick();
        expect(result.extinct).toBe(false);
        expect(result.newEpoch).toBe(false);
        session.stage = Stage.Larva;
        planted = backgroundFounders(sim) > 0;
      }
      expect(planted).toBe(true);
      expect(sim.epoch).toBe(1);
    });

    it('plants another founder while the background stays below the floor', () => {
      // A capacity this large keeps the young colony under the 15 percent floor.
      const sim = new Simulation({ capacity: 50000, mutationRate: 1 }, 13);
      const founders = new Set<number>();
      for (let i = 0; i < 130; i++) {
        sim.tick();
        for (const o of sim.organisms) if (o.parentId === null) founders.add(o.id);
      }
      expect(founders.size).toBeGreaterThan(1);
    });

    it('leaves a thriving background alone', () => {
      const sim = new Simulation(settings, 11);
      for (let i = 0; i < 200; i++) sim.tick();
      expect(sim.livingCount()).toBeGreaterThan(settings.capacity * 0.15);
      const lineages = new Set(sim.organisms.map((o) => o.lineage));
      for (let i = 0; i < 200; i++) sim.tick();
      for (const o of sim.organisms) if (o.parentId === null) expect(lineages.has(o.lineage)).toBe(true);
    });
  });

  it('children inherit lineage and descend one generation deeper', () => {
    const sim = new Simulation(settings, 21);
    for (let i = 0; i < 30; i++) {
      for (const { parent, child } of sim.tick().births) {
        expect(child.lineage).toBe(parent.lineage);
        expect(child.depth).toBe(parent.depth + 1);
      }
    }
  });

  describe('lineage traits', () => {
    it('pins the hue of a traited lineage while untraited lineages drift', () => {
      const sim = new Simulation(settings, 31);
      const pinned = sim.found(5, 0, 0);
      const free = sim.found(-5, 0, 0);
      sim.lineageTraits.set(pinned.lineage, { fertility: 1, hue: 0.9 });
      let pinnedChildren = 0;
      const freeHues = new Set<number>();
      for (let i = 0; i < 80; i++) {
        for (const { child } of sim.tick().births) {
          if (child.lineage === pinned.lineage) {
            pinnedChildren++;
            expect(child.genome.hue).toBe(0.9);
          } else if (child.lineage === free.lineage) freeHues.add(child.genome.hue);
        }
      }
      expect(pinnedChildren).toBeGreaterThan(0);
      expect(freeHues.size).toBeGreaterThan(1);
    });

    it('never reproduces at fertility 0', () => {
      const sim = new Simulation(settings, 32);
      const sterile = sim.found(5, 0, 0);
      sim.lineageTraits.set(sterile.lineage, { fertility: 0, hue: 0.1 });
      for (let i = 0; i < 80; i++) {
        for (const { parent } of sim.tick().births) expect(parent.lineage).not.toBe(sterile.lineage);
      }
    });

    it('spares a traited lineage from blights', () => {
      let blights = 0;
      // Blights are rare; these seeds are ones that roll some within 400 ticks.
      for (const seed of [48, 51, 54]) {
        const sim = new Simulation(settings, seed);
        const immune = sim.found(0, 0, 0);
        sim.lineageTraits.set(immune.lineage, { fertility: 1, hue: 0.3 });
        for (let i = 0; i < 400; i++) {
          const result = sim.tick();
          if (!result.blight) continue;
          blights++;
          // Blight kills are counted only for untraited organisms, so they cannot exceed those deaths.
          const untraitedDeaths = result.deaths.filter((o) => o.lineage !== immune.lineage).length;
          expect(result.blight.killed).toBeLessThanOrEqual(untraitedDeaths);
        }
      }
      expect(blights).toBeGreaterThan(0);
    });

    it('never targets a blight when every living lineage is traited', () => {
      for (const seed of [51, 52, 53]) {
        const sim = new Simulation(settings, seed);
        sim.lineageTraits.set(sim.organisms[0].lineage, { fertility: 1, hue: 0.3 });
        for (let i = 0; i < 400; i++) {
          const result = sim.tick();
          // A refounded epoch or a reseeded background plants an untraited lineage, which can be blighted.
          if (sim.organisms.some((o) => !sim.lineageTraits.has(o.lineage))) break;
          expect(result.blight).toBeNull();
        }
      }
    });
  });
});
