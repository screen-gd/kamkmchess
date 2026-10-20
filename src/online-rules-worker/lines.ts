import { StringDecoder } from 'node:string_decoder';

export interface BoundedLineReaderOptions {
  /** Maximum bytes in one request line, excluding the newline. */
  readonly maxBytes: number;
  /** Handles one complete line. Returning false stops reading. */
  readonly onLine: (line: string) => Promise<boolean>;
  /**
   * Reports one oversized line. The reader retains nothing from that line and
   * resumes at the next newline, so a hostile or truncated writer cannot grow
   * its buffer without bound.
   */
  readonly onOversized?: () => Promise<boolean>;
}

/**
 * Newline-delimited reader with a hard per-line byte bound. A line that exceeds
 * the bound is answered once and then discarded as it streams in; only the
 * current line is ever buffered.
 */
export class BoundedLineReader {
  private readonly options: BoundedLineReaderOptions;
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private discarding = false;
  private stopped = false;

  constructor(options: BoundedLineReaderOptions) {
    this.options = options;
  }

  /** Bytes retained for the line currently being assembled. */
  get bufferedBytes(): number {
    return Buffer.byteLength(this.buffer, 'utf8');
  }

  /** True while the remainder of an already-rejected line is being dropped. */
  get discardingOversizedLine(): boolean {
    return this.discarding;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Feeds one chunk and reports whether the consumer wants more input. */
  async push(chunk: Buffer | string): Promise<boolean> {
    if (this.stopped) return false;
    let pending = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);

    for (;;) {
      if (this.discarding) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        pending = pending.slice(newline + 1);
        this.discarding = false;
        if (pending.length === 0) break;
        continue;
      }

      const newline = pending.indexOf('\n');
      const segment = newline < 0 ? pending : pending.slice(0, newline);
      const rest = newline < 0 ? '' : pending.slice(newline + 1);
      const overLimit = this.bufferedBytes + Buffer.byteLength(segment, 'utf8') > this.options.maxBytes;
      const line = overLimit ? '' : this.buffer + segment;
      this.buffer = '';

      if (overLimit) {
        // An unterminated oversized line keeps the discard flag until the next
        // newline arrives; a terminated one resumes immediately.
        this.discarding = newline < 0;
        pending = rest;
        if (!(await this.rejectOversized())) return false;
        if (this.discarding || pending.length === 0) break;
        continue;
      }

      if (newline < 0) {
        this.buffer = line;
        break;
      }
      pending = rest;
      if (!(await this.dispatch(line))) return false;
      if (pending.length === 0) break;
    }

    return !this.stopped;
  }

  /** Flushes the decoder and any final unterminated line. */
  async end(): Promise<boolean> {
    if (this.stopped) return false;
    const tail = this.decoder.end();
    if (tail.length > 0 && !(await this.push(tail))) return false;
    if (this.discarding) {
      this.discarding = false;
      return true;
    }

    const line = this.buffer;
    this.buffer = '';
    if (line.trim().length === 0) return true;
    if (Buffer.byteLength(line, 'utf8') > this.options.maxBytes) return this.rejectOversized();
    return this.dispatch(line);
  }

  private async dispatch(line: string): Promise<boolean> {
    const proceed = await this.options.onLine(line);
    if (!proceed) this.stopped = true;
    return proceed;
  }

  private async rejectOversized(): Promise<boolean> {
    if (this.options.onOversized === undefined) return true;
    const proceed = await this.options.onOversized();
    if (!proceed) this.stopped = true;
    return proceed;
  }
}
