export function rel(metaUrl, spec, version) {
  const url = new URL(spec, metaUrl);
  url.searchParams.set("v", String(version || 0));
  return import(url.href);
}
