#!/usr/bin/env node
// Test fixture: a fake runner that emits one JSON line per its role.
const role = process.env.FAKE_ROLE ?? "ok";
if (role === "ok") {
  process.stdout.write(JSON.stringify({ ok: true, userId: "test" }) + "\n");
  process.exit(0);
}
if (role === "fail") {
  process.stderr.write("simulated failure\n");
  process.stdout.write(JSON.stringify({ ok: false, reason: "simulated" }) + "\n");
  process.exit(2);
}
if (role === "hang") {
  // never exits — used to test timeouts
  setInterval(() => {}, 100000);
}
