import type { RealDemoRunner } from "./demo/realRunner";
import type { ScenarioRunner } from "./demo/scenarios";
import type { LiveHub } from "./live";
import type { DataStore } from "./store";

/** What every route module gets. */
export interface AppContext {
  store: DataStore;
  hub: LiveHub;
  /** Fixture mode: synthesizes one decision per POST /demo/:scenario. */
  runScenario: ScenarioRunner;
  /** Mongo mode: runs the real XRPL Testnet scenarios (null in fixture mode). */
  demoRunner: RealDemoRunner | null;
  /** POST /events/payment needs header x-events-token = this, when set. */
  eventsToken?: string;
  /** GET /subscribers needs header x-api-token = this, when set. */
  subscribersToken?: string;
  /** DEV_ROUTES=1: allow POST /dev/flip in mongo mode. */
  devRoutes: boolean;
  version: string;
}
