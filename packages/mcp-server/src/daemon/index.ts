export { attachToDaemon } from "./attach.js";
export { appendAuditEntry, getAuditLogPath, readAuditTail } from "./audit.js";
export {
  ensureDaemon,
  getDaemonStatus,
  rotateDaemonToken,
  startDaemon,
  stopDaemon,
} from "./launcher.js";
export { acquire, getLockfilePath, isStale, read, release, replace } from "./lockfile.js";
export { startDaemonServer } from "./server.js";
export { ensureToken, generateBearerToken, getTokenPath, readToken, rotateToken } from "./token.js";
export type { DaemonHealthStatus, DaemonStatus, DaemonConnectionInfo, StartedDaemonInstance } from "./launcher.js";
export type { DaemonLockRecord } from "./lockfile.js";
export type { StartedDaemonServer } from "./server.js";
export type { DaemonTokenRecord } from "./token.js";
