export function decodeParams(value) {
  if (typeof value !== "string" || !value) {
    return {};
  }
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return Object.fromEntries(new URLSearchParams(decoded).entries());
  } catch {
    return {};
  }
}

export function num(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function asMs(value) {
  const n = num(value, 0);
  if (!n) {
    return 0;
  }
  return n < 1e12 ? n * 1000 : n;
}

export function truthy(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}
