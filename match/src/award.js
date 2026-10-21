export function validateAwardJSON(raw) {
  if (!raw) {
    return;
  }
  let ranks;
  try {
    ranks = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("invalid award json");
  }
  if (!Array.isArray(ranks)) {
    throw new Error("award must be an array");
  }
  for (const rank of ranks) {
    if (!rank || rank.rank <= 0) {
      throw new Error("invalid rank");
    }
    if (!Array.isArray(rank.items)) {
      throw new Error("award items required");
    }
    for (const item of rank.items) {
      if (item.kind === "money") {
        if (!item.currency || !item.amount) {
          throw new Error("money reward requires currency and amount");
        }
      } else if (item.kind === "ticket") {
        if (!item.ticketId || !item.amount) {
          throw new Error("ticket reward requires ticketId and amount");
        }
      } else {
        throw new Error(`unknown reward kind ${item.kind}`);
      }
    }
  }
}
