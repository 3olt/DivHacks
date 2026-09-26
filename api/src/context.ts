import type { ScenarioRunner } from "./demo/scenarios";
import type { LiveHub } from "./live";
import type { DataStore } from "./store";

/** What every route module gets. */
export interface AppContext {
  store: DataStore;
  hub: LiveHub;
  runScenario: ScenarioRunner;
  version: string;
}
