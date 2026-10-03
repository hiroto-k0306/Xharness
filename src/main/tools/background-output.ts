/** Unread UTF-8 output, bounded in bytes. Retain the newest 1 MiB. */
export class BackgroundOutput {
  private bytes = Buffer.alloc(0);
  private omitted = Buffer.alloc(0);
  private dropped = 0;
  append(text: string) {
    this.bytes = Buffer.concat([this.bytes, Buffer.from(text)]);
    let excess = this.pending - 1048576;
    for (const field of ["omitted", "bytes"] as const) {
      if (excess <= 0) break;
      const buffer = this[field];
      let cut = Math.min(excess, buffer.length);
      while (cut < buffer.length && (buffer[cut]! & 0xc0) === 0x80) cut++;
      this[field] = Buffer.from(buffer.subarray(cut));
      this.dropped += cut;
      excess -= cut;
    }
  }
  get pending() {
    return this.omitted.length + this.bytes.length;
  }
  read(clean: (s: string) => string = (s) => s) {
    // Mask the whole pending text before slicing, including secrets across chunks.
    // Finish the unread middle of the previous snapshot before newer output.
    const batch = this.omitted.length ? this.omitted : this.bytes;
    if (this.omitted.length) this.omitted = Buffer.alloc(0);
    else this.bytes = Buffer.alloc(0);
    const text = clean(batch.toString("utf8"));
    const marker = "\n… 中略（次のBashOutputで取得） …\n";
    let output = text;
    if (text.length > 30000) {
      let head = Math.floor((30000 - marker.length) / 2);
      let tailStart = text.length - (30000 - marker.length - head);
      if (/[\uD800-\uDBFF]/u.test(text[head - 1]!)) head--;
      if (/[\uDC00-\uDFFF]/u.test(text[tailStart]!)) tailStart++;
      output = text.slice(0, head) + marker + text.slice(tailStart);
      this.omitted = Buffer.from(text.slice(head, tailStart));
    }
    const droppedBytes = this.dropped;
    this.dropped = 0;
    return { output, remainingBytes: this.pending, droppedBytes };
  }
}
