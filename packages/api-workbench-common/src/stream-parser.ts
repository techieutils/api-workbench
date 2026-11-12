/** Incremental SSE parser: supports split CRLF, multiline data, IDs, comments, and UTF-8 decoder callers. */
export class SSEParser {
  private line = '';
  private skipLF = false;
  private data: string[] = [];
  private name = '';
  private id = '';
  private size = 0;
  constructor(
    private readonly emit: (event: { data: string; event: string; eventId: string }) => void,
  ) {}
  feed(chunk: string): void {
    for (const character of chunk) {
      if (this.skipLF && character === '\n') {
        this.skipLF = false;
        continue;
      }
      this.skipLF = false;
      if (character === '\r' || character === '\n') {
        this.consume();
        this.skipLF = character === '\r';
      } else {
        this.line += character;
        if (++this.size > 1024 * 1024) throw new Error('SSE event exceeds 1 MiB.');
      }
    }
  }
  private consume(): void {
    const line = this.line;
    this.line = '';
    if (!line) {
      if (this.data.length)
        this.emit({ data: this.data.join('\n'), event: this.name || 'message', eventId: this.id });
      this.data = [];
      this.name = '';
      this.size = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') this.data.push(value);
    if (field === 'event') this.name = value;
    if (field === 'id' && !value.includes('\0')) this.id = value;
  }
}
export class NDJSONParser {
  private buffer = '';
  constructor(private readonly emit: (data: string) => void) {}
  feed(chunk: string, final = false): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      this.line(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
    }
    if (this.buffer.length > 1024 * 1024) throw new Error('NDJSON line exceeds 1 MiB.');
    if (final && this.buffer.trim()) {
      this.line(this.buffer);
      this.buffer = '';
    }
  }
  private line(line: string): void {
    if (!line.trim()) return;
    if (line.length > 1024 * 1024) throw new Error('NDJSON line exceeds 1 MiB.');
    JSON.parse(line);
    this.emit(line.trim());
  }
}
