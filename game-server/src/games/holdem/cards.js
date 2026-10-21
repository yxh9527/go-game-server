const SUITS = ["DIAMOND", "CLUB", "HEART", "SPADE"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export function cardName(id) {
  const suit = Math.floor(id / 13);
  const rank = id % 13;
  return `${SUITS[suit]}_${RANKS[rank]}`;
}

export function rankValue(id) {
  const rank = id % 13;
  return rank === 0 ? 14 : rank + 1;
}

export function makeDeck() {
  return Array.from({ length: 52 }, (_, i) => i);
}

export function shuffle(deck, rng = Math.random) {
  const cards = deck.slice();
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function isStraight(values) {
  const uniq = [...new Set(values)].sort((a, b) => b - a);
  if (uniq.length < 5) {
    return null;
  }
  for (let i = 0; i <= uniq.length - 5; i += 1) {
    if (uniq[i] - uniq[i + 4] === 4) {
      return uniq.slice(i, i + 5);
    }
  }
  if (uniq.includes(14) && uniq.includes(5) && uniq.includes(4) && uniq.includes(3) && uniq.includes(2)) {
    return [5, 4, 3, 2, 1];
  }
  return null;
}

export function evaluate7(ids) {
  const cards = ids.map((id) => ({
    id,
    suit: Math.floor(id / 13),
    value: rankValue(id),
  }));
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a += 1) {
    for (let b = a + 1; b < n - 3; b += 1) {
      for (let c = b + 1; c < n - 2; c += 1) {
        for (let d = c + 1; d < n - 1; d += 1) {
          for (let e = d + 1; e < n; e += 1) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const ranked = rankFive(five);
            if (!best || compareRank(ranked, best) > 0) {
              best = ranked;
            }
          }
        }
      }
    }
  }
  return best;
}

function rankFive(five) {
  const values = five.map((c) => c.value).sort((a, b) => b - a);
  const suits = five.map((c) => c.suit);
  const flush = suits.every((s) => s === suits[0]);
  const straight = isStraight(values);
  const counts = new Map();
  for (const v of values) {
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ids = five.map((c) => c.id);
  if (flush && straight && straight[0] === 14) {
    return pack(10, "ROYAL_FLUSH", straight, ids);
  }
  if (flush && straight) {
    return pack(9, "STRAIGHT_FLUSH", straight, ids);
  }
  if (groups[0][1] === 4) {
    return pack(8, "FOUR", [groups[0][0], groups[1][0]], ids);
  }
  if (groups[0][1] === 3 && groups[1][1] === 2) {
    return pack(7, "FULL_HOUSE", [groups[0][0], groups[1][0]], ids);
  }
  if (flush) {
    return pack(6, "FLUSH", values, ids);
  }
  if (straight) {
    return pack(5, "STRAIGHT", straight, ids);
  }
  if (groups[0][1] === 3) {
    const kickers = groups.slice(1).map((g) => g[0]);
    return pack(4, "TRIPS", [groups[0][0], ...kickers], ids);
  }
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairA = Math.max(groups[0][0], groups[1][0]);
    const pairB = Math.min(groups[0][0], groups[1][0]);
    return pack(3, "TWO_PAIR", [pairA, pairB, groups[2][0]], ids);
  }
  if (groups[0][1] === 2) {
    const kickers = groups.slice(1).map((g) => g[0]);
    return pack(2, "PAIR", [groups[0][0], ...kickers], ids);
  }
  return pack(1, "HIGH", values, ids);
}

function pack(cardTypeId, name, key, ids) {
  return {
    cardTypeId,
    name,
    key,
    best5: ids,
    pokerEnumList: ids.map(cardName),
  };
}

export function compareRank(a, b) {
  if (a.cardTypeId !== b.cardTypeId) {
    return a.cardTypeId - b.cardTypeId;
  }
  const n = Math.max(a.key.length, b.key.length);
  for (let i = 0; i < n; i += 1) {
    const dv = (a.key[i] || 0) - (b.key[i] || 0);
    if (dv) {
      return dv;
    }
  }
  return 0;
}

export function baccaratValue(id) {
  const rank = id % 13;
  if (rank === 0) {
    return 1;
  }
  if (rank >= 9) {
    return 0;
  }
  return rank + 1;
}

export function baccaratTotal(ids) {
  return ids.reduce((sum, id) => sum + baccaratValue(id), 0) % 10;
}

export function drawBaccarat(deck, pos) {
  const player = [deck[pos], deck[pos + 1]];
  const banker = [deck[pos + 2], deck[pos + 3]];
  let next = pos + 4;
  const p = baccaratTotal(player);
  const b = baccaratTotal(banker);
  let playerThird = null;
  if (p <= 5 && b < 8) {
    playerThird = deck[next];
    player.push(playerThird);
    next += 1;
  }
  const natural = p >= 8 || b >= 8;
  if (!natural) {
    const pt = baccaratTotal(player);
    let take = false;
    if (!playerThird) {
      take = b <= 5;
    } else {
      const v = baccaratValue(playerThird);
      if (b <= 2) {
        take = true;
      } else if (b === 3) {
        take = v !== 8;
      } else if (b === 4) {
        take = v >= 2 && v <= 7;
      } else if (b === 5) {
        take = v >= 4 && v <= 7;
      } else if (b === 6) {
        take = v === 6 || v === 7;
      }
    }
    if (take) {
      banker.push(deck[next]);
      next += 1;
    }
  }
  return { player, banker, next };
}
