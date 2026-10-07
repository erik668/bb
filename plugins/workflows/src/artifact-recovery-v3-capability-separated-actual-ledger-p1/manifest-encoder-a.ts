const encodeScalarA = (value: null | boolean | number | string): string => JSON.stringify(value);

const canonicalA = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return encodeScalarA(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalA).join(",")}]`;
  if (typeof value !== "object") throw new Error("MANIFEST_VALUE_REJECTED_A");
  const object = value as Record<string, unknown>;
  const members = Object.getOwnPropertyNames(object).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  return `{${members.map((key) => `${JSON.stringify(key)}:${canonicalA(object[key])}`).join(",")}}`;
};

export const encodeManifestA = (manifest: unknown): Buffer => Buffer.from(canonicalA(manifest), "utf8");

