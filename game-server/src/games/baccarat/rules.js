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

// The original renderer reads index 0 after turning over the first two cards,
// and index 1 only after the third card has been exposed.
export function pointStages(cards) {
  return cards.length > 2 ? [baccaratTotal(cards.slice(0, 2)), baccaratTotal(cards)] : [baccaratTotal(cards)];
}

export function winningAreas(player, banker) {
  const p = baccaratTotal(player), b = baccaratTotal(banker);
  const areas = [p > b ? 1 : b > p ? 2 : 3];
  if (player[0] % 13 === player[1] % 13) areas.push(4);
  if (banker[0] % 13 === banker[1] % 13) areas.push(5);
  if (b > p && b === 6) areas.push(6);
  if (p > b && p === 7) areas.push(7);
  if (p === 7 && b === 6) areas.push(8);
  if (p !== b) areas.push(9);
  return { areas, p, b };
}

export function winningOdds(areaId, result, config) {
  if (areaId === 6) return config.sideOdds[6][result.banker.length === 3 ? 1 : 0];
  if (areaId === 7) return config.sideOdds[7][result.player.length === 3 ? 1 : 0];
  if (areaId === 8) return config.sideOdds[8][result.player.length + result.banker.length - 4];
  return config.odds[areaId];
}

export function supplyState(player, banker) {
  const p = player.length === 3, b = banker.length === 3;
  if (!p && !b) return 1;
  if (p && b) return baccaratTotal(banker.slice(0, 2)) <= 2 ? 2 : 3;
  return p ? 4 : 5;
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
    if (playerThird === null) {
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
