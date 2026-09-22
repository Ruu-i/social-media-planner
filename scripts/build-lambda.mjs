import { build } from "esbuild";
import { rm, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Bundle the Lambda into a single file.
 *
 * Bundling rather than shipping node_modules: the AWS SDK v3 alone is tens of
 * megabytes, and the deployment package limit is 50 MB zipped. esbuild tree-
 * shakes it to a fraction of that, and a single file has no cold-start cost
 * spent resolving hundreds of modules.
 *
 * `@aws-sdk/*` is NOT marked external. The Lambda Node runtime bundles v3, but
 * pinning our own copy means the deployed behaviour matches what the tests ran
 * against rather than whatever version the runtime happens to carry.
 */
await rm("dist-lambda", { recursive: true, force: true });
await mkdir("dist-lambda", { recursive: true });

const result = await build({
  entryPoints: ["src/lambda/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist-lambda/index.mjs",
  // `awslambda` is a runtime global, not a module — esbuild must not try to
  // resolve it.
  external: [],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  metafile: true,
  minify: false, // readable stack traces in CloudWatch are worth the bytes
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`  bundled: dist-lambda/index.mjs  (${(bytes / 1024 / 1024).toFixed(2)} MB)`);

// Zip it, using whatever the platform has.
const zip = spawnSync(
  process.platform === "win32" ? "powershell" : "zip",
  process.platform === "win32"
    ? ["-NoProfile", "-Command", "Compress-Archive -Path dist-lambda/* -DestinationPath dist-lambda/function.zip -Force"]
    : ["-j", "dist-lambda/function.zip", "dist-lambda/index.mjs"],
  { stdio: "inherit" },
);

if (zip.status !== 0) {
  console.error("  zip failed — Terraform can still package the directory");
} else {
  console.log("  packaged: dist-lambda/function.zip");
}
