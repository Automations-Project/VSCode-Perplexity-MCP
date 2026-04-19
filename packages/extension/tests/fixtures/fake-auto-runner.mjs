#!/usr/bin/env node
// Simulates login-runner: sends {phase:"awaiting_otp"} via IPC, waits for
// {otp} reply, then emits one JSON line and exits.
process.send?.({ phase: "awaiting_otp", attempt: 0 });
process.on("message", (m) => {
  if (m?.otp === "123456") {
    process.stdout.write(JSON.stringify({ ok: true, tier: "Pro" }) + "\n");
    process.exit(0);
  }
  if (m?.otp) {
    process.stdout.write(JSON.stringify({ ok: false, reason: "otp_rejected" }) + "\n");
    process.exit(2);
  }
});
