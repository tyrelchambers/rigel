export interface WatchEvent { type: "ADDED" | "MODIFIED" | "DELETED"; object: any }

/** Frames concatenated JSON objects from a kubectl --output-watch-events stream. */
export class WatchEventParser {
  private buf = "";

  push(chunk: string, emit: (e: WatchEvent) => void): void {
    this.buf += chunk;
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") { if (depth === 0) start = i; depth++; }
      else if (c === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          emit(JSON.parse(this.buf.slice(start, i + 1)));
          this.buf = this.buf.slice(i + 1);
          i = -1; start = -1;
        }
      }
    }
  }
}
