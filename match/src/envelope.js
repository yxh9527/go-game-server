export function newEnvelope(event, payload) {
  return JSON.stringify({
    event,
    data: JSON.stringify(payload ?? {}),
  });
}
