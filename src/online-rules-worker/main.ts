import { sanitizeWorkerEnvironment } from './environment.js';
import {
  handleRulesWorkerLine,
  serializeRulesWorkerResponse,
  type RulesWorkerResponse,
} from './evaluate.js';
import { BoundedLineReader } from './lines.js';
import { LIMITS, rejectionResponse } from './protocol.js';

let stopped = false;

sanitizeWorkerEnvironment(process.env);

function writeLine(line: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(`${line}\n`, (error) => {
      if (error) {
        stopped = true;
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

async function writeResponse(response: RulesWorkerResponse): Promise<boolean> {
  let text: string;
  try {
    text = serializeRulesWorkerResponse(response);
  } catch {
    text = JSON.stringify(rejectionResponse(response.requestId, 'internal-error', 'The rules worker could not serialize this response.'));
  }
  return writeLine(text);
}

const reader = new BoundedLineReader({
  maxBytes: LIMITS.maxRequestBytes,
  onLine: (line) => (stopped ? Promise.resolve(false) : writeResponse(handleRulesWorkerLine(line))),
  onOversized: () => writeResponse(rejectionResponse(
    null,
    'request-too-large',
    'Request line exceeds the protocol size limit.',
  )),
});

async function run(): Promise<void> {
  for await (const chunk of process.stdin) {
    if (!(await reader.push(chunk))) return;
    if (stopped) return;
  }
  if (stopped) return;
  await reader.end();
}

process.stdout.on('error', () => {
  stopped = true;
});

run().then(
  () => {
    process.exitCode = 0;
  },
  () => {
    process.exitCode = 1;
  },
);
