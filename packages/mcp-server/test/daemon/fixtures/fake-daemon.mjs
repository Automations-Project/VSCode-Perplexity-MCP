// A minimal stand-in for a daemon from a DIFFERENT build: a real, foreign
// process that answers /daemon/health perfectly. That is the whole point of
// the code-graph gate — a stale-version daemon is not sick, it is a healthy
// process whose hashed ESM chunks were overwritten on disk by the upgrade, so
// it responds fine and then fails every code-split dynamic import forever.
//
// argv: <uuid> <bearerToken>
// Prints `{"port":N}` on stdout once listening.
import { createServer } from "node:http";

const [uuid, bearer] = process.argv.slice(2);

const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (url.startsWith("/daemon/health") && req.headers.authorization === `Bearer ${bearer}`) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        pid: process.pid,
        uuid,
        version: "0.0.1-old",
        port: server.address().port,
        uptimeMs: 1,
        startedAt: new Date(0).toISOString(),
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n");
});
