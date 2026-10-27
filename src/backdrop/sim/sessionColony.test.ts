import { describe, expect, it } from 'vitest';
import { createRng } from './rng';
import { SimSessionColony } from './sessionColony';
import { Simulation } from './simulation';
import { Stage } from './stages';

const settings = { capacity: 800, mutationRate: 1 };

function lineageOfHue(sim: Simulation, hue: number): number {
  for (const [lineage, traits] of sim.lineageTraits) if (traits.hue === hue) return lineage;
  throw new Error(`no lineage with hue ${hue}`);
}

function livingIn(sim: Simulation, lineage: number): number {
  let n = 0;
  for (const o of sim.organisms) if (o.lineage === lineage && o.stage !== Stage.Husk) n++;
  return n;
}

function setup(seed = 1) {
  const sim = new Simulation(settings, seed);
  const colony = new SimSessionColony(sim, createRng(seed + 1000));
  return { sim, colony };
}

describe('SimSessionColony', () => {
  it('founds one spore with the session hue and registers idle traits', () => {
    const { sim, colony } = setup();
    const before = sim.organisms.length;
    colony.ensure('a', 0.9);
    expect(sim.organisms).toHaveLength(before + 1);
    const founder = sim.organisms[sim.organisms.length - 1];
    expect(founder.stage).toBe(Stage.Spore);
    expect(founder.genome.hue).toBe(0.9);
    expect(sim.lineageTraits.get(founder.lineage)).toEqual({ fertility: 0.35, hue: 0.9 });
    const offset = Math.hypot(founder.x, founder.y, founder.z);
    expect(offset).toBeGreaterThanOrEqual(4);
    expect(offset).toBeLessThanOrEqual(8);
    // Drifts back toward the colony at the origin.
    expect(founder.vx * founder.x + founder.vy * founder.y + founder.vz * founder.z).toBeLessThan(0);
  });

  it('ignores a second ensure for the same session', () => {
    const { sim, colony } = setup();
    colony.ensure('a', 0.9);
    const count = sim.organisms.length;
    colony.ensure('a', 0.1);
    expect(sim.organisms).toHaveLength(count);
    expect(sim.lineageTraits.size).toBe(1);
  });

  it('maps moods onto fertility and the pulse set', () => {
    const { sim, colony } = setup();
    colony.ensure('a', 0.9);
    const lineage = lineageOfHue(sim, 0.9);
    colony.setMood('a', 'busy');
    expect(sim.lineageTraits.get(lineage)?.fertility).toBe(1.8);
    expect(colony.pulsingLineages().size).toBe(0);
    colony.setMood('a', 'waiting');
    expect(sim.lineageTraits.get(lineage)?.fertility).toBe(1.8);
    expect([...colony.pulsingLineages()]).toEqual([lineage]);
    colony.setMood('a', 'idle');
    expect(sim.lineageTraits.get(lineage)?.fertility).toBe(0.35);
    expect(colony.pulsingLineages().size).toBe(0);
  });

  it('releases the lineage to age out untraited', () => {
    const { sim, colony } = setup();
    colony.ensure('a', 0.9);
    const lineage = lineageOfHue(sim, 0.9);
    colony.setMood('a', 'waiting');
    colony.release('a');
    expect(sim.lineageTraits.has(lineage)).toBe(false);
    expect(colony.pulsingLineages().size).toBe(0);
    expect(livingIn(sim, lineage)).toBe(1);
  });

  it('re-founds a session lineage that dies out and carries its traits over', () => {
    const { sim, colony } = setup();
    colony.ensure('a', 0.9);
    colony.setMood('a', 'busy');
    const old = lineageOfHue(sim, 0.9);
    for (const o of sim.organisms) if (o.lineage === old) o.stage = Stage.Husk;
    colony.afterTick();
    const fresh = lineageOfHue(sim, 0.9);
    expect(fresh).not.toBe(old);
    expect(sim.lineageTraits.has(old)).toBe(false);
    expect(sim.lineageTraits.get(fresh)).toEqual({ fertility: 1.8, hue: 0.9 });
    expect(livingIn(sim, fresh)).toBe(1);
    expect(sim.organisms.find((o) => o.lineage === fresh)?.genome.hue).toBe(0.9);
  });

  it('leaves a living session lineage alone', () => {
    const { sim, colony } = setup();
    colony.ensure('a', 0.9);
    const lineage = lineageOfHue(sim, 0.9);
    const count = sim.organisms.length;
    colony.afterTick();
    expect(sim.organisms).toHaveLength(count);
    expect(lineageOfHue(sim, 0.9)).toBe(lineage);
  });

  it('lets a busy session outgrow an idle one', () => {
    let busyTotal = 0;
    let idleTotal = 0;
    let busyWins = 0;
    const seeds = [21, 22, 23, 24, 25, 26];
    for (const seed of seeds) {
      const { sim, colony } = setup(seed);
      colony.ensure('busy', 0.1);
      colony.ensure('idle', 0.3);
      colony.setMood('busy', 'busy');
      colony.setMood('idle', 'idle');
      let busy = 0;
      let idle = 0;
      for (let i = 0; i < 300; i++) {
        sim.tick();
        colony.afterTick();
        busy += livingIn(sim, lineageOfHue(sim, 0.1));
        idle += livingIn(sim, lineageOfHue(sim, 0.3));
      }
      busyTotal += busy;
      idleTotal += idle;
      if (busy > idle) busyWins++;
    }
    expect(busyTotal).toBeGreaterThan(idleTotal * 1.5);
    expect(busyWins).toBeGreaterThanOrEqual(seeds.length - 1);
  });
});
