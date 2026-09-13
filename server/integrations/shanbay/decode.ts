/*
 * Adapted from OJZen/shanbay_words_backup (GPL-2.0).
 * Private personal-use WordLoop project.
 */

class TinyMt {
  private status: [number, number, number, number] = [0, 0, 0, 0];
  private mat1 = 0;
  private mat2 = 0;
  private tmat = 0;
  private u32(value: number): number { return value >>> 0; }
  seed(value: string): void {
    for (let i = 0; i < 4; i++) this.status[i] = this.u32(value.charCodeAt(i) || 110);
    this.mat1 = this.status[1]; this.mat2 = this.status[2]; this.tmat = this.status[3];
    for (let i = 0; i < 7; i++) {
      const current = (i & 3) as 0 | 1 | 2 | 3;
      const next = ((i + 1) & 3) as 0 | 1 | 2 | 3;
      this.status[next] = this.u32(this.status[next]
        ^ (i + 1 + Math.imul(1812433253, this.status[current] ^ (this.status[current] >>> 30))));
    }
    if ((this.status[0] & 0x7fffffff) === 0 && this.status[1] === 0 && this.status[2] === 0 && this.status[3] === 0) {
      this.status = [66, 65, 89, 83];
    }
    for (let i = 0; i < 8; i++) this.nextState();
  }
  private nextState(): void {
    let y = this.status[3];
    let x = (this.status[0] & 0x7fffffff) ^ this.status[1] ^ this.status[2];
    x ^= x << 1; y ^= (y >>> 1) ^ x;
    this.status[0] = this.status[1]; this.status[1] = this.status[2];
    this.status[2] = this.u32(x ^ (y << 10)); this.status[3] = this.u32(y);
    if ((y & 1) !== 0) { this.status[1] ^= this.mat1; this.status[2] ^= this.mat2; }
  }
  generate(max: number): number {
    this.nextState();
    const x = this.status[0] ^ (this.status[2] >>> 8);
    let y = this.status[3] ^ x;
    if ((x & 1) !== 0) y ^= this.tmat;
    return (y >>> 0) % max;
  }
}

function versionValue(char: string): number {
  const code = char.charCodeAt(0);
  return code >= 65 ? code - 65 : code - 65 + 41;
}

export function decodeShanbayData(payload: string): unknown {
  if (payload.length < 5) throw new Error("Unable to decode Shanbay response.");
  const version = ((32 * versionValue(payload[0]!) + versionValue(payload[1]!)) * versionValue(payload[2]!) + versionValue(payload[3]!)) % 32;
  if (version > 1) throw new Error("Unable to decode Shanbay response.");
  const rng = new TinyMt(); rng.seed(payload.slice(0, 4));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const symbols = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lengths = [1, 2, 2, 2, 2, 2];
  type Node = { char?: string; children: Map<string, Node> };
  const root: Node = { children: new Map() };
  for (let i = 0; i < symbols.length; i++) {
    let node = root;
    const length = lengths[Math.trunc((i + 1) / 11)]!;
    for (let j = 0; j < length; j++) {
      let char = alphabet[rng.generate(32)]!;
      while (node.children.get(char)?.char && node.children.get(char)?.char !== ".") char = alphabet[rng.generate(32)]!;
      if (!node.children.has(char)) node.children.set(char, { children: new Map() });
      node = node.children.get(char)!;
    }
    node.char = symbols[i];
  }
  let base64 = "";
  for (let i = 4; i < payload.length;) {
    if (payload[i] === "=") { base64 += "="; i++; continue; }
    let node = root;
    while (node.children.has(payload[i]!)) { node = node.children.get(payload[i]!)!; i++; }
    if (!node.char) throw new Error("Unable to decode Shanbay response.");
    base64 += node.char;
  }
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Unable to decode Shanbay response.");
  }
}

export function unwrapShanbayPayload(payload: unknown): unknown {
  if (typeof payload === "object" && payload !== null && "data" in payload) {
    const data = (payload as { data?: unknown }).data;
    return typeof data === "string" ? decodeShanbayData(data) : data;
  }
  return payload;
}
