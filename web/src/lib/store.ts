// In-memory store for sign-up profiles (personal data: name, age, address).
// Map data comes from the backend API. Move profiles to the API once it has a profile field on Subscriber.
import type { SubscriberProfile } from "./types";

const g = globalThis as unknown as { __profiles?: Map<string, SubscriberProfile> };
const profiles: Map<string, SubscriberProfile> = (g.__profiles ??= new Map());

export function getProfile(phone: string): SubscriberProfile | undefined {
  return profiles.get(phone);
}

export function saveProfile(profile: SubscriberProfile): void {
  profiles.set(profile.phone, profile);
}
