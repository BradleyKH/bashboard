/**
 * The uniforms the stars and the gas plate share. Both materials hold these same objects, so one
 * write per frame reaches both.
 */
export function createGalaxyUniforms() {
  return {
    uTime: { value: 0 },
    uSpin: { value: 0 },
    uWanderTime: { value: 0 },
    uWanderAmp: { value: 0 },
  };
}

export type GalaxyUniforms = ReturnType<typeof createGalaxyUniforms>;
