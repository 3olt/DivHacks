"use client";

import { useState } from "react";
import type { IMessageStatus } from "@/lib/imessage";
import { savePhone } from "@/lib/savedPhone";
import IMessageNotice from "./IMessageNotice";
import TextLinePrompt from "./TextLinePrompt";

const BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];
const LANGUAGES = ["English", "Spanish", "Chinese", "Russian", "Bengali", "Haitian Creole", "Korean", "Arabic", "Other"];
// Values are the API's SiteType.
const INTERESTS = [
  { value: "food_pantry", label: "Food pantries" },
  { value: "grocery_giveaway", label: "Grocery giveaways" },
  { value: "shelter", label: "Shelters" },
  { value: "youth_program", label: "Youth programs" },
  { value: "event", label: "Community events" },
];

const input = "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none";

export default function SignupForm() {
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<IMessageStatus | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setState("sending");
    const res = await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: form.get("phone"),
        first_name: form.get("first_name"),
        age: form.get("age"),
        street_address: form.get("street_address"),
        zip: form.get("zip"),
        borough: form.get("borough"),
        household_size: form.get("household_size"),
        language: form.get("language"),
        interests: form.getAll("interests"),
        consent_sms: form.get("consent_sms") === "on",
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setState("error");
      setError(data.error ?? "Sign-up failed");
      return;
    }
    savePhone(data.phone);
    setStatus(data.imessage);
    setState("idle");
  }

  if (status) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-900">You&apos;re signed up.</p>
        <IMessageNotice status={status} />
        {status !== "live" && <TextLinePrompt />}
        <p className="text-xs text-gray-600">Click any pin and choose &quot;Follow this location&quot; to get its alerts.</p>
        <button onClick={() => setStatus(null)} className="text-xs text-gray-600 underline">
          Edit my info
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Phone number (for iMessage)" required>
        <input name="phone" type="tel" required autoComplete="tel" placeholder="(212) 555-1234" className={input} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name">
          <input name="first_name" autoComplete="given-name" className={input} />
        </Field>
        <Field label="Age">
          <input name="age" type="number" min={0} max={120} className={input} />
        </Field>
      </div>
      <Field label="Street address">
        <input name="street_address" autoComplete="street-address" className={input} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="ZIP code" required>
          <input name="zip" required inputMode="numeric" pattern="\d{5}" autoComplete="postal-code" className={input} />
        </Field>
        <Field label="Borough">
          <select name="borough" defaultValue="" className={input}>
            <option value="">Select</option>
            {BOROUGHS.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="People in household">
          <input name="household_size" type="number" min={1} max={20} className={input} />
        </Field>
        <Field label="Preferred language">
          <select name="language" defaultValue="English" className={input}>
            {LANGUAGES.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-gray-700">Alert me about</legend>
        <div className="grid grid-cols-2 gap-1">
          {INTERESTS.map((i) => (
            <label key={i.value} className="flex items-center gap-2 text-sm text-gray-800">
              <input type="checkbox" name="interests" value={i.value} defaultChecked={i.value === "food_pantry" || i.value === "grocery_giveaway"} />
              {i.label}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Placeholder: more intake questions go here (SNAP/WIC eligibility, dietary needs, accessibility). */}
      <div className="rounded-md border border-dashed border-gray-300 p-3 text-xs text-gray-500">
        More questions coming soon: eligibility, dietary needs, accessibility.
      </div>

      <label className="flex items-start gap-2 text-xs text-gray-700">
        <input type="checkbox" name="consent_sms" required className="mt-0.5" />
        I agree to receive iMessage alerts at this number. Reply STOP to opt out.
      </label>
      <button type="submit" disabled={state === "sending"} className="w-full rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
        {state === "sending" ? "Signing up…" : "Get iMessage alerts"}
      </button>
      {state === "error" && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-700">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </span>
      {children}
    </label>
  );
}
