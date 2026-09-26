"use client";

import { useSyncExternalStore } from "react";

// The signed-up phone number is remembered per browser so "follow this location" is one click.
const KEY = "signup_phone";
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function savePhone(phone: string): void {
  try {
    localStorage.setItem(KEY, phone);
  } catch {
    // storage unavailable; the user just has to sign up again next visit
  }
  listeners.forEach((l) => l());
}

export function useSavedPhone(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => null,
  );
}
