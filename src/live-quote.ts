import { pathToFileURL } from "node:url";
import { loadEnvFile } from "./env.js";
import { quoteMainnetMove } from "./live-move.js";

loadEnvFile();

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  quoteMainnetMove()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "live quote failed";
      process.stderr.write(`${message}\nNothing was signed.\n`);
      process.exitCode = 1;
    });
}
