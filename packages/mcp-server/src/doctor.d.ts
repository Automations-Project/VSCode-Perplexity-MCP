export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

export type DoctorCategory =
  | "runtime" | "config" | "profiles" | "vault" | "browser"
  | "native-deps" | "network" | "ide" | "mcp" | "probe";

export interface DoctorCheck {
  category: DoctorCategory;
  name: string;
  status: DoctorStatus;
  message: string;
  detail?: Record<string, unknown>;
  hint?: string;
}

export interface DoctorReport {
  overall: DoctorStatus;
  generatedAt: string;
  durationMs: number;
  activeProfile: string | null;
  probeRan: boolean;
  byCategory: Record<DoctorCategory, {
    status: DoctorStatus;
    checks: DoctorCheck[];
  }>;
}

export interface RunAllOpts {
  configDir?: string;
  profile?: string;
  probe?: boolean;
  allProfiles?: boolean;
  ideStatuses?: Record<string, unknown>;
  baseDir?: string;
  injected?: Partial<Record<DoctorCategory, DoctorCheck[]>>;
}

export const CATEGORIES: ReadonlyArray<DoctorCategory>;
export function rollupStatus(statuses: DoctorStatus[]): DoctorStatus;
export function exitCodeFor(report: { overall: DoctorStatus }): number;
export function runAll(opts?: RunAllOpts): Promise<DoctorReport>;
export function formatReportMarkdown(report: DoctorReport): string;
