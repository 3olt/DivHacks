"use client";

import { useState } from "react";
import { DEMO_SCENARIOS, resetDemo, runDemo, type DemoScenario } from "@/lib/api";

const LABELS: Record<DemoScenario, string> = {
  happy: "Pay a verified invoice",
  injection: "Prompt-injected invoice",
  duplicate: "Duplicate invoice",
  "over-contract": "Over contract amount",
  "address-swap": "Wallet-change scam",
  "over-limit": "Over auto-pay limit",
  "kill-switch": "Revoke the agent's key",
};

// Triggers the backend's demo scenarios (POST /demo/:scenario). Results arrive over the live WebSocket.
export default function DemoControls() {
  const [running, setRunning] = useState<DemoScenario | "reset" | null>(null);
  const [error, setError] = useState("");

  async function run(action: DemoScenario | "reset") {
    setRunning(action);
    setError("");
    try {
      if (action === "reset") await resetDemo();
      else await runDemo(action);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setRunning(null);
    }
  }

  return (
    <details className="rounded-md border border-gray-200 p-3">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-gray-500">Demo controls</summary>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {DEMO_SCENARIOS.map((s) => (
          <button
            key={s}
            onClick={() => run(s)}
            disabled={running !== null}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-left text-xs text-gray-800 hover:border-gray-900 disabled:opacity-50"
          >
            {running === s ? "Running…" : LABELS[s]}
          </button>
        ))}
        <button onClick={() => run("reset")} disabled={running !== null} className="rounded-md px-2 py-1.5 text-left text-xs text-gray-500 underline disabled:opacity-50">
          {running === "reset" ? "Resetting…" : "Reset demo data"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </details>
  );
}
