// Only this player's own thirteen cards/recommendations enter the policy.
export function choose(options, random = Math.random) {
  if (!options.length) return null;
  return options[random() < 0.85 ? 0 : Math.floor(random() * options.length)];
}
export function thinkTime(random = Math.random) { return 6500 + Math.floor(random() * 6500); }
