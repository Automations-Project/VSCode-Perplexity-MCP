export interface ProfileMeta {
  name: string;
  displayName: string;
  createdAt: string;
  loginMode?: string;
  tier?: string;
  lastLogin?: string;
}

export interface ProfilePaths {
  dir: string;
  meta: string;
  vault: string;
  vaultPlain: string;
  browserData: string;
  modelsCache: string;
  history: string;
  attachments: string;
  researches: string;
  reinit: string;
}

export function getConfigDir(): string;
export function getProfilesDir(): string;
export function getProfilePaths(name: string): ProfilePaths;
export function validateName(name: string): string | null;
export function createProfile(name: string, opts?: { displayName?: string; loginMode?: string }): ProfileMeta;
export function listProfiles(): ProfileMeta[];
export function getProfile(name: string): ProfileMeta | null;
export function deleteProfile(name: string): void;
export function getActiveName(): string | null;
export function getActive(): ProfileMeta | null;
export function setActive(name: string): void;
export function suggestNextDefaultName(): string;
export function renameProfile(oldName: string, newName: string): void;
export function recordLoginSuccess(
  name: string,
  opts: { tier: string; loginMode: string; lastLogin: string }
): ProfileMeta;
