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
