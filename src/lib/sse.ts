/**
 * Incremental Server-Sent Events parser.
 *
 * The Hermes session stream is a POST, so the browser's EventSource can't be
 * used; we read the fetch body ourselves and feed chunks in here. Handles
 * frames split across chunks, CRLF line endings, comment keepalives
 * (`: keepalive`) and multi-line `data:` fields.
 */
export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = "";

  /** Feed a decoded text chunk; returns every frame completed by it. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const frames: SseFrame[] = [];
    let sep: number;
    while ((sep = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const frame = parseBlock(block);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Flush a trailing frame the server closed without a blank line. */
  end(): SseFrame[] {
    const rest = this.buffer;
    this.buffer = "";
    const frame = rest.trim() ? parseBlock(rest) : null;
    return frame ? [frame] : [];
  }
}

function parseBlock(block: string): SseFrame | null {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (!data.length) return null;
  return { event, data: data.join("\n"), id };
}
