import { pathToFileURL } from "node:url";
import { loadEnvFile } from "./env.js";
import { statusMainnetMove } from "./live-move.js";

loadEnvFile();

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const depositAddress = process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? "";
  statusMainnetMove(depositAddress)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "status poll failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
