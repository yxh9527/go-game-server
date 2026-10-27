// The decision input contains only the cards visible to this player. Hidden
// fifth cards and opponents' hands are never passed to this policy.
export function choose({ cards, grabMax, multiples, phase, auto }, random = Math.random) {
  const faces = cards.filter(c => c >= 52 || c % 13 >= 9).length;
  const wilds = cards.filter(c => c >= 52).length;
  const confidence = cards.length ? Math.min(0.9, 0.18 + faces * 0.12 + wilds * 0.15) : 0.3;
  if (phase === 'grab') {
    if (auto) return Math.min(grabMax, auto.grab);
    return random() < confidence ? Math.min(grabMax, 1 + Math.floor(random() * Math.max(1, grabMax))) : 0;
  }
  if (phase === 'bet') {
    if (auto) return multiples.filter(n => n <= auto.multiple).at(-1) || multiples[0];
    const index = Math.min(multiples.length - 1, Math.floor((confidence * 0.6 + random() * 0.4) * multiples.length));
    return multiples[index];
  }
  return 0;
}
