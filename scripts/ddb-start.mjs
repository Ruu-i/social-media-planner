import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Start DynamoDB Local.
 *
 * The Java jar rather than Docker, so it needs nothing running in the
 * background beyond a JRE. -inMemory means each start is a clean slate.
 */
if (!existsSync(".ddb-local/DynamoDBLocal.jar")) {
  console.error(
    "\n  .ddb-local/DynamoDBLocal.jar is missing.\n" +
      "  Download it from:\n" +
      "  https://s3.us-west-2.amazonaws.com/dynamodb-local/dynamodb_local_latest.zip\n" +
      "  and unzip into .ddb-local/\n",
  );
  process.exit(1);
}

spawn(
  "java",
  ["-Djava.library.path=./.ddb-local/DynamoDBLocal_lib", "-jar", "./.ddb-local/DynamoDBLocal.jar", "-inMemory", "-port", "8000"],
  { detached: true, stdio: "ignore" },
).unref();

console.log("DynamoDB Local starting on http://localhost:8000");
