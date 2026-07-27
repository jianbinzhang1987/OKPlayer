function ipv4Parts(value: string): number[] | undefined {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return parts;
}

export function isProxyFakeAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^\[|\]$/g, "");
  const parts = ipv4Parts(address);
  if (parts) {
    const [a = 0, b = 0] = parts;
    return a === 198 && (b === 18 || b === 19);
  }
  return address === "fdfe:dcba:9876::" || address.startsWith("fdfe:dcba:9876:");
}

export function isNonPublicAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (address === "::" || address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;

  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a = 0, b = 0] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

export function isUnsafeResolvedAddress(value: string): boolean {
  return isNonPublicAddress(value) && !isProxyFakeAddress(value);
}
