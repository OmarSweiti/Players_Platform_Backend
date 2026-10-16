// The committed contract (0.3.9): writes openapi/openapi.json from the code,
// without starting a server or reaching a database (src/contract.ts).
//   npm run openapi    then commit the file; CI regenerates it and diffs
import './contract-env';
import { writeFileSync } from 'node:fs';
import {
  CONTRACT_FILE,
  generateContract,
  serializeContract,
} from '../src/contract';

async function main() {
  writeFileSync(CONTRACT_FILE, serializeContract(await generateContract()));
  process.stdout.write(`wrote ${CONTRACT_FILE}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `openapi: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
