// Shared by every game's op=38 room list. This file participates in hot reload.
// Amounts use the same protocol units as carryMin, with no currency conversion.
export const roomPopulationConfig = {
  enabled: true,
  timeZone: "Asia/Shanghai",
  refreshSeconds: 5,
  minPeople: 8,
  maxPeople: 100,
  entryReference: 500,
  entryDecay: 0.45,
  randomAmplitude: 0.035,
  randomPeriodSeconds: 60,
  seed: "gogame-room-population-v1",
  activity: {
    midnight: 1,
    low: 0.20,
    noon: 0.65,
    afternoon: 0.45,
  },
};
