const walkB = (input: unknown): Uint8Array => {
  if (Array.isArray(input)) {
    const children = input.map((member) => Buffer.from(walkB(member)).toString("utf8"));
    return Buffer.from(`[${children.join(",")}]`);
  }
  if (input !== null && typeof input === "object") {
    const source = input as Record<string, unknown>;
    const names: string[] = [];
    for (const name in source) {
      if (Object.prototype.hasOwnProperty.call(source, name)) names.push(name);
    }
    names.sort();
    const encoded: string[] = [];
    for (const name of names) {
      encoded.push(`${JSON.stringify(name)}:${Buffer.from(walkB(source[name])).toString("utf8")}`);
    }
    return Buffer.from(`{${encoded.join(",")}}`);
  }
  if (input === undefined || typeof input === "function" || typeof input === "symbol") {
    throw new Error("MANIFEST_VALUE_REJECTED_B");
  }
  return Buffer.from(JSON.stringify(input));
};

export const encodeManifestB = (manifest: unknown): Buffer => Buffer.from(walkB(manifest));

export const admitNoTerminalNewline = (bytes: Uint8Array): void => {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] === 10) {
    throw new Error("TERMINAL_NEWLINE_MUTANT_KILLED");
  }
};

