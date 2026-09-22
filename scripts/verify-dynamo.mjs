import { spawnSync } from "node:child_process";

/**
 * Run the assertion suite against DynamoDB Local.
 *
 * A file rather than an inline `node -e` in package.json: the nested quoting
 * that would need is unreadable and breaks outright in PowerShell.
 *
 * `shell: true` on Windows is required, not cosmetic. Since the Node 20.12
 * security fix, spawning a `.cmd` shim — which is what `npx` is on Windows —
 * fails with EINVAL unless it goes through a shell. Every argument here is a
 * literal, so there is nothing to inject.
 */
const isWindows = process.platform === "win32";

const result = spawnSync(isWindows ? "npx.cmd" : "npx", ["tsx", "src/verify.ts"], {
  stdio: "inherit",
  shell: isWindows,
  env: {
    ...process.env,
    STORE: "dynamo",
    DDB_ENDPOINT: process.env.DDB_ENDPOINT ?? "http://localhost:8000",
    AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
  },
});

if (result.error) {
  console.error(`\n  Could not run the suite: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
