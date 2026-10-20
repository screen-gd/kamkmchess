import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { RULES_POLICY_VERSION } from './protocol.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const INITIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

let workerEntry = '';

function requestLine(fen = INITIAL, intent?: unknown): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId: 'process-1',
    rulesPolicyVersion: RULES_POLICY_VERSION,
    matchVersion: 5,
    fen,
    history: [fen],
    ...(intent === undefined ? {} : { intent }),
  });
}

class WorkerProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: string[] = [];
  private readonly waiters: ((line: string) => void)[] = [];
  private readonly stderr: string[] = [];

  constructor(entry: string, environment: NodeJS.ProcessEnv = {}) {
    this.child = spawn(process.execPath, [entry], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr.push(chunk.toString('utf8'));
    });
  }

  send(line: string): Promise<string> {
    this.child.stdin.write(`${line}\n`);
    return this.next();
  }

  write(text: string): void {
    this.child.stdin.write(text);
  }

  next(timeoutMs = 10_000): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a worker response.')), timeoutMs);
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await once(this.child, 'close');
  }

  diagnostics(): string {
    return this.stderr.join('');
  }
}

beforeAll(async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'kha66-rules-worker-'));
  await build({
    configFile: false,
    root: repoRoot,
    logLevel: 'silent',
    build: {
      ssr: join(repoRoot, 'src/online-rules-worker/main.ts'),
      outDir,
      emptyOutDir: true,
      target: 'node24',
      minify: false,
      rollupOptions: { output: { entryFileNames: 'worker.mjs', format: 'es' } },
    },
    ssr: { noExternal: true },
  });
  workerEntry = join(outDir, 'worker.mjs');
}, 60_000);

afterAll(async () => {
  if (workerEntry) await rm(join(workerEntry, '..'), { recursive: true, force: true });
});

describe('[KHA-66] private worker process protocol', () => {
  it('evaluates a move over stdin/stdout with a stable fingerprint', async () => {
    const worker = new WorkerProcess(workerEntry);
    try {
      const response = JSON.parse(await worker.send(requestLine(INITIAL, { kind: 'move', from: 'e2', to: 'e4' }))) as Record<string, unknown>;
      expect(response.status).toBe('ok');
      expect(response.requestId).toBe('process-1');
      expect(response.matchVersion).toBe(5);
      expect(response.inputFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect((response.candidate as Record<string, unknown>).resultingFen).toBe(
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      );
    } finally {
      await worker.close();
    }
  });

  it('keeps serving after malformed and oversized lines without leaking a candidate', async () => {
    const worker = new WorkerProcess(workerEntry);
    try {
      const malformed = JSON.parse(await worker.send('{"protocolVersion":')) as Record<string, unknown>;
      expect(malformed).toMatchObject({ status: 'rejected', code: 'malformed-json', requestId: null });
      expect(malformed).not.toHaveProperty('candidate');

      const oversized = JSON.parse(await worker.send('x'.repeat(300 * 1024))) as Record<string, unknown>;
      expect(oversized).toMatchObject({ status: 'rejected', code: 'request-too-large' });
      expect(oversized).not.toHaveProperty('candidate');

      const invalidFen = JSON.parse(await worker.send(requestLine('not-a-fen'))) as Record<string, unknown>;
      expect(invalidFen.status).toBe('rejected');
      expect(invalidFen.code).toBe('invalid-fen');
      expect(invalidFen).not.toHaveProperty('candidate');

      const valid = JSON.parse(await worker.send(requestLine())) as Record<string, unknown>;
      expect(valid.status).toBe('ok');
      expect(valid.candidate).toBeNull();
    } finally {
      await worker.close();
    }
  });

  it('discards a streamed oversized line without buffering it and resumes at the next newline', async () => {
    const worker = new WorkerProcess(workerEntry);
    try {
      // Leave the oversized line unterminated across several writes. The
      // worker should reject it once, then discard its remainder until the
      // newline before processing another request.
      worker.write('x'.repeat(150 * 1024));
      worker.write('x'.repeat(150 * 1024));
      const oversized = JSON.parse(await worker.next()) as Record<string, unknown>;
      expect(oversized).toMatchObject({ status: 'rejected', code: 'request-too-large' });
      expect(oversized).not.toHaveProperty('candidate');

      worker.write('\n');
      const valid = JSON.parse(await worker.send(requestLine())) as Record<string, unknown>;
      expect(valid.status).toBe('ok');
      expect(valid.requestId).toBe('process-1');
    } finally {
      await worker.close();
    }
  });

  it('starts with only allowlisted environment variables', async () => {
    const worker = new WorkerProcess(workerEntry, { DATABASE_URL: 'canary-database', OPENAI_API_KEY: 'canary-provider' });
    try {
      const response = JSON.parse(await worker.send(requestLine())) as Record<string, unknown>;
      expect(response.status).toBe('ok');
      expect(worker.diagnostics()).not.toContain('canary');
    } finally {
      await worker.close();
    }
  });
});
