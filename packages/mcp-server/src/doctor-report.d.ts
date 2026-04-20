import type { DoctorReport, DoctorCategory } from "./doctor.js";

export function buildIssueBody(input: {
  report: DoctorReport;
  stderrTail: string;
  extVersion: string;
  nodeVersion: string;
  os: string;
  activeTier?: string | null;
}): string;

export function redactIssueBody(md: string): string;

export function decideTransport(input: { bodyBytes: number }): "inline" | "file";

export function buildIssueUrl(input: {
  owner: string;
  repo: string;
  category: DoctorCategory | string;
  check: string;
  body: string;
}): string;
