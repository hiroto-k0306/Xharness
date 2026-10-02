/** Unread UTF-8 output, bounded in bytes. Retain the newest 1 MiB. */
export class BackgroundOutput {
  private bytes = Buffer.alloc(0);
  private dropped = 0;
  append(text: string) {
    this.bytes = Buffer.concat([this.bytes, Buffer.from(text)]);
    if (this.bytes.length > 1048576) {
      const excess = this.bytes.length - 1048576;
      this.dropped += excess;
      this.bytes = Buffer.from(this.bytes.subarray(excess));
    }
  }
  get pending() {
    return this.bytes.length;
  }
  read(clean: (s: string) => string = (s) => s) {
    // Mask the whole pending text before slicing, including secrets across chunks.
    const text = clean(this.bytes.toString("utf8"));
    const marker = "\n… 中略（次のBashOutputで取得） …\n";
    let output = text;
    if (text.length > 30000) {
      const head = Math.floor((30000 - marker.length) / 2);
      const tail = 30000 - marker.length - head;
      output = text.slice(0, head) + marker + text.slice(-tail);
      this.bytes = Buffer.from(text.slice(head, -tail));
    } else this.bytes = Buffer.alloc(0);
    const droppedBytes = this.dropped;
    this.dropped = 0;
    return { output, remainingBytes: this.pending, droppedBytes };
  }
}
