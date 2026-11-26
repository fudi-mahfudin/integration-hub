// The mock's FHIR types are globals from @types/fhir; this keeps them visible
// to packages that boot the mock through this entry (the hub's tests).
/// <reference types="fhir" />
import type { Clock } from './clock.js';
import type { MockConfig } from './config.js';
import { FaultRules } from './faults.js';
import { Parking } from './parking.js';
import { Platform } from './platform.js';
import { buildServer } from './server.js';
import { SubmissionLog } from './submission-log.js';
import { loadWorld } from './world/world.js';

/** What the mock takes from its runtime besides configuration. */
export interface MockRuntime {
  /** "Now" for the mock: the wall clock standalone; tests move it across token expiry and throttle windows. */
  clock: Clock;
}

/** A booted mock SATUSEHAT. */
export interface MockSatusehat {
  /** Starts listening and resolves to the base URL, e.g. `http://127.0.0.1:41234/`. */
  listen(): Promise<URL>;
  /** Stops the HTTP server. */
  close(): Promise<void>;
}

/**
 * The composition root of the mock SATUSEHAT: `main.ts` and every test boot
 * it through here. Loads the world dataset once; reset reloads it from memory.
 */
export async function createMockSatusehat(config: MockConfig, runtime: MockRuntime): Promise<MockSatusehat> {
  const world = await loadWorld(config.worldPath);
  const platform = new Platform(world, config, runtime.clock);
  const app = buildServer({ platform, log: new SubmissionLog(), faults: new FaultRules(), parking: new Parking(runtime.clock), clock: runtime.clock });
  return {
    async listen() {
      const address = await app.listen({ host: config.host, port: config.port });
      return new URL(`${address}/`);
    },
    close: () => app.close(),
  };
}
