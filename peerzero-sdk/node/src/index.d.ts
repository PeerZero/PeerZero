import { KeyObject } from 'crypto';

export class VerificationError extends Error {
  name: 'VerificationError';
}

export interface Skill {
  skill: string;
  name: string;
  strength: number;
  reliability: number;
  reps: number;
  streak: number;
}

export interface ParsedProfile {
  handle: string | null;
  level: string;
  tier: number;
  grade: number;
  graduated: boolean;
  overallScore: number;
  verifiedSkills: Skill[];
  developingSkills: Skill[];
  untestedSkills: Skill[];
  testingSummary: Record<string, unknown>;
  methodology: string;
  isSigned: boolean;
  isExpired: boolean;
  signedAt: string | null;
  expiresAt: string | null;
}

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
}

export interface PeerZeroExtensions {
  certification: Record<string, unknown>;
  overallScore: number;
  verifiedSkills: Skill[];
  developingSkills: Skill[];
  avatar: { config: Record<string, unknown>; evolution_stage: number; evolution_name: string } | null;
  profile: Record<string, unknown>;
}

export interface ParsedAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: Record<string, unknown>;
  skills: A2ASkill[];
  peerzero: PeerZeroExtensions | null;
  isPeerZeroBot: boolean;
  isSigned: boolean;
}

/**
 * Verify a signed portable profile's Ed25519 signature.
 * Auto-fetches the public key from the profile's verification_url if not provided.
 */
export function verify(
  profile: Record<string, unknown>,
  publicKey?: string | KeyObject,
): Promise<Record<string, unknown>>;

/** Parse a portable profile into structured data (does not verify signature). */
export function parseProfile(profile: Record<string, unknown>): ParsedProfile;

/** Parse an A2A Agent Card and extract PeerZero extensions. */
export function parseAgentCard(card: Record<string, unknown>): ParsedAgentCard;

/** Check whether a profile's signature has expired. */
export function isExpired(profile: Record<string, unknown>): boolean;

/** Fetch the School's Ed25519 public key. Cached after first call. */
export function getPublicKey(schoolUrl?: string): Promise<KeyObject>;

/** Clear the cached public key (for key rotation). */
export function clearKeyCache(): void;
