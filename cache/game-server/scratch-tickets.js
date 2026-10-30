import { randomInt, createHash } from 'node:crypto';
import { walletOf } from '../../game-server/src/wallet/index.js';
import { rel } from '../../game-server/src/rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { ERROR, kindOf, prizeFromMask, publicTicket } = await rel(import.meta.url, '../../game-server/src/games/ggl-core/rules.js', v);

// Development inventory only. Uniform symbols are a test generator, not the
// production lottery's unpublished prize distribution or return rate.
export function createScratchTickets({ resident = {}, draw = () => Array.from({ length: 20 }, () => randomInt(1, 11)), now = Date.now } = {}) {
  const accounts = resident.accounts ||= new Map(), markets = resident.markets ||= new Map(), tasks = resident.tasks ||= new Map();
  resident.bookSequence ||= 1;
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const accountKey = ctx => Number(ctx.session.agentId ?? ctx.table.agentId ?? 0) + ':' + Number(ctx.session.userId);
  const marketKey = ctx => Number(ctx.session.agentId ?? ctx.table.agentId ?? 0) + ':' + kindOf(ctx.table);
  function account(ctx) {
    const key = accountKey(ctx);
    if (!(resident.nextSweep > now())) {
      for (const [id, a] of accounts) if (!a.pending.size && now() - a.lastSeen > 8 * 3600000 && !tasks.has(id)) accounts.delete(id);
      for (const inventory of markets.values()) for (const [serial, sold] of inventory) {
        if (now() - sold.at > 24 * 3600000 && !accounts.get(sold.owner)?.pending.has(serial)) inventory.delete(serial);
      }
      resident.nextSweep = now() + 60000;
    }
    if (!accounts.has(key)) accounts.set(key, { pending: new Map(), revealed: new Map(), history: [], accumulated: { GGL1: 0, GGL2: 0 }, offers: new Map() });
    accounts.get(key).lastSeen = now();
    return accounts.get(key);
  }
  function market(ctx) {
    const key = marketKey(ctx);
    if (!markets.has(key)) markets.set(key, new Map());
    return markets.get(key);
  }
  function run(ctx, fn) {
    const key = accountKey(ctx), previous = tasks.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(fn);
    tasks.set(key, task);
    return task.finally(() => { if (tasks.get(key) === task) tasks.delete(key); });
  }
  function totals(a) { return { accumulatedWin: a.accumulated.GGL1 + a.accumulated.GGL2, accumulatedWinByKind: { ...a.accumulated } }; }
  function price(ctx, body) {
    const value = body.faceValue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || !ctx.table.config.denominations.includes(value)) fail(ERROR.INVALID, 'Invalid denomination');
    return value;
  }
  function bookId(ctx, suffix = '') {
    const date = new Date(now());
    const stamp = String(date.getFullYear()).slice(2) + String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0');
    const width = 7 - suffix.length;
    const id = width ? String(resident.bookSequence++ % (10 ** width)).padStart(width, '0') + suffix : suffix;
    return kindOf(ctx.table) + '-' + stamp + '-' + id;
  }
  function serial(book, index) {
    const prefix = book + '-' + String(index).padStart(2, '0');
    return prefix + '-' + (createHash('sha256').update(prefix).digest()[0] % 10);
  }
  function offer(a, id, data) { a.offers.set(id, { ...data, expires: now() + 60000 }); }
  function pruneOffers(a) {
    for (const [key, value] of a.offers) if (value.expires < now()) a.offers.delete(key);
    while (a.offers.size > 100) a.offers.delete(a.offers.keys().next().value);
  }
  async function refresh(ctx) { await walletOf(ctx).load?.(ctx.session); }
  async function persist(ctx) { await walletOf(ctx).persist?.(ctx.session); }
  function ticket(ctx, full, faceValue) {
    const huMask = draw(ctx).slice();
    const prize = prizeFromMask(huMask, ctx.table.config.winMultipliers);
    return { serialFull: full, faceValue, kind: kindOf(ctx.table), huMask, ...prize, winAmount: faceValue * prize.multiplier,
      roomId: ctx.table.roomId, roomType: ctx.table.roomType, gameRoomId: ctx.table.gameRoomId, credited: false, complete: false };
  }
  async function purchaseInside(ctx, body, direct = false) {
    const a = account(ctx), inventory = market(ctx), faceValue = price(ctx, body), kind = kindOf(ctx.table);
    pruneOffers(a);
    if (a.pending.size >= 100) fail(ERROR.INVALID, 'Reveal pending tickets first');
    if (direct && [...a.pending.values()].some(t => t.kind === kind)) fail(ERROR.STORAGE, 'Resume purchased tickets before buying another');
    let refs, bookMode = false;
    if (direct) refs = [serial(bookId(ctx), 1)];
    else {
      if (!['RANDOM_SINGLE', 'FULL_BOOK'].includes(body.purchaseMode)) fail(ERROR.INVALID, 'Invalid purchase mode');
      bookMode = body.purchaseMode !== 'RANDOM_SINGLE';
      refs = bookMode ? body.bookId7List : body.serialFulls;
      if (!Array.isArray(refs) || !refs.length || refs.length > (bookMode ? 5 : 100) || refs.some(r => typeof r !== 'string' || r.length > 80)) fail(ERROR.INVALID, 'Invalid ticket selection');
      if (new Set(refs).size !== refs.length) fail(ERROR.INVALID, 'Duplicate ticket selection');
    }
    const selected = [], failedItems = [];
    for (const ref of refs) {
      const found = a.offers.get(ref), fulls = direct ? [ref] : found?.kind === kind && found.book === bookMode ? found.serials : [];
      if (!fulls?.length || fulls.some(id => inventory.has(id))) { failedItems.push({ ref, code: ERROR.INVALID }); continue; }
      selected.push(...fulls);
    }
    if (!selected.length) fail(ERROR.INVALID, 'Tickets unavailable or already sold');
    if (a.pending.size + selected.length > 100 || new Set(selected).size !== selected.length) fail(ERROR.INVALID, 'Too many or overlapping tickets');
    // Generate privately before charging; neither search nor pending response
    // exposes symbols, prize amounts, or any future result.
    const tickets = selected.map(id => ticket(ctx, id, faceValue));
    for (const t of tickets) inventory.set(t.serialFull, { owner: accountKey(ctx), at: now() });
    try {
      const paid = await walletOf(ctx).debit(ctx.session, faceValue * tickets.length, { transactionId: 'scratch:buy:' + tickets[0].serialFull });
      if (!paid?.ok) fail(ERROR.BALANCE, 'Insufficient balance');
    } catch (err) {
      for (const t of tickets) inventory.delete(t.serialFull);
      throw err;
    }
    // Install pending state before persistence, so reconnect never charges again.
    for (const t of tickets) a.pending.set(t.serialFull, t);
    for (const ref of refs) a.offers.delete(ref);
    await persist(ctx);
    return { code: 0, purchaseMode: body.purchaseMode, newTickets: tickets.map(publicTicket), failedItems,
      walletAmount: ctx.session.wallet, ...totals(a) };
  }
  async function revealInside(ctx, body) {
    const a = account(ctx), kind = kindOf(ctx.table);
    if (!['SPECIFIED', 'RANDOM_BUY_REVEAL'].includes(body.revealMode)) fail(ERROR.INVALID, 'Invalid reveal mode');
    let full = body.serialFull;
    if (body.revealMode === 'RANDOM_BUY_REVEAL') {
      if (full !== '') fail(ERROR.INVALID, 'Random reveal must not contain serial');
      const result = await purchaseInside(ctx, body, true);
      full = result.newTickets[0].serialFull;
    }
    if (typeof full !== 'string' || full.length > 80) fail(ERROR.INVALID, 'Invalid serial');
    const t = a.pending.get(full) || a.revealed.get(full);
    if (!t || t.kind !== kind) fail(ERROR.STORAGE, 'Ticket does not belong to this account and kind');
    if (!t.credited) {
      if (t.winAmount > 0) {
        const paid = await walletOf(ctx).credit(ctx.session, t.winAmount, { transactionId: 'scratch:win:' + full });
        if (!paid?.ok) fail(ERROR.STORAGE, 'Prize credit failed; ticket remains pending');
      }
      t.credited = true;
    }
    await persist(ctx);
    if (!t.complete) {
      t.complete = true;
      a.accumulated[kind.toUpperCase()] += t.winAmount;
      a.pending.delete(full); a.revealed.set(full, t);
      a.history.unshift({ huCount: t.huCount, amount: t.winAmount - t.faceValue, huMask: t.huMask.slice(),
        faceValue: t.faceValue, multiplier: t.multiplier, roomType: t.roomType, serialNo: full,
        roomId: t.roomId, gameRoomId: t.gameRoomId });
      const counts = new Map();
      a.history = a.history.filter(row => {
        const key = row.roomType + ':' + row.roomId, count = (counts.get(key) || 0) + 1;
        counts.set(key, count); return count <= 100;
      });
      while (a.revealed.size > 200) a.revealed.delete(a.revealed.keys().next().value);
    }
    return { code: 0, serialFull: full, faceValue: t.faceValue, huCount: t.huCount, multiplier: t.multiplier,
      winAmount: t.winAmount, prizeTier: t.prizeTier, huMask: t.huMask.slice(), walletAmount: ctx.session.wallet,
      gglKind: kind.toUpperCase(), ...totals(a) };
  }
  return {
    state(ctx) { return run(ctx, async () => {
      await refresh(ctx); const a = account(ctx), kind = kindOf(ctx.table);
      return { code: 0, walletAmount: ctx.session.wallet, pendingTickets: [...a.pending.values()].filter(t => t.kind === kind).map(publicTicket),
        denominations: ctx.table.config.denominations.slice(), winMultipliers: ctx.table.config.winMultipliers.slice(), ...totals(a) };
    }); },
    reveal(ctx, body) { return run(ctx, async () => { await refresh(ctx); return revealInside(ctx, body); }); },
    purchase(ctx, body) { return run(ctx, async () => { await refresh(ctx); return purchaseInside(ctx, body); }); },
    search(ctx, body) { return run(ctx, async () => {
      if (!['BOOK_TAIL', 'SINGLE_TICKET'].includes(body.searchType) || typeof body.bookTail !== 'string' || !/^\d{1,7}$/.test(body.bookTail)
        || (body.searchType === 'SINGLE_TICKET' && (typeof body.ticketTail !== 'string' || !/^\d{1,2}$/.test(body.ticketTail) || Number(body.ticketTail) < 1 || Number(body.ticketTail) > 20))) fail(ERROR.INVALID, 'Invalid serial suffix');
      const a = account(ctx), inventory = market(ctx), matchedSerials = [], kind = kindOf(ctx.table);
      pruneOffers(a);
      for (let i = 0; i < 10; i++) {
        const book = bookId(ctx, body.bookTail), serials = Array.from({ length: 20 }, (_, n) => serial(book, n + 1));
        if (body.searchType === 'BOOK_TAIL') {
          if (serials.every(id => !inventory.has(id)) && !matchedSerials.includes(book)) { matchedSerials.push(book); offer(a, book, { kind, book: true, serials }); }
        } else for (let n = 1; n <= 20; n++) {
          const full = serials[n - 1];
          if (String(n).padStart(2, '0').endsWith(body.ticketTail) && !inventory.has(full) && !matchedSerials.includes(full)) { matchedSerials.push(full); offer(a, full, { kind, book: false, serials: [full] }); }
        }
      }
      return { code: 0, searchType: body.searchType, matchedSerials, bookTail: body.bookTail, ticketTail: body.ticketTail };
    }); },
    history(ctx) { return run(ctx, () => account(ctx).history.filter(r => r.roomId === ctx.table.roomId && r.roomType === ctx.table.roomType)
      .slice(0, 100).reverse().map(({ roomId, gameRoomId, ...row }) => structuredClone(row))); },
  };
}
