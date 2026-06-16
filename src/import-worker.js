import path from 'node:path';
import { buildLookupDatabase } from './importer.js';

function getArg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const inputPath = getArg('input') ?? process.argv[2];
const outputPath = getArg('output') ?? path.resolve('data/scpper-ratings.db');

function send(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

try {
  await buildLookupDatabase({
    inputPath,
    outputPath,
    progress: send,
  });
} catch (error) {
  send({ phase: 'error', message: error.message, stack: error.stack });
  process.exitCode = 1;
}
