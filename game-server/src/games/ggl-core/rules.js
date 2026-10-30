// Original gglmj/gglsj help: symbol 1 wins; N symbols select the Nth multiplier.
export const WIN_MULTIPLIERS = Object.freeze([0.5, 1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 100, 150, 200, 300, 500, 1000, 2000, 5000, 10000]);
export const DENOMINATIONS = Object.freeze([100, 200, 500, 1000, 2000, 3000, 5000, 10000]);
export const ERROR = Object.freeze({ INVALID: 99400, BALANCE: 99048, DEBIT: 99079, STORAGE: 100085 });
export function prizeFromMask(mask, multipliers = WIN_MULTIPLIERS) {
  if (!Array.isArray(mask) || mask.length !== 20 || mask.some(n => !Number.isInteger(n) || n < 1 || n > 10)) throw new Error('Invalid scratch ticket symbols');
  const huCount = mask.filter(n => n === 1).length;
  const multiplier = huCount ? multipliers[huCount - 1] : 0;
  if (!Number.isFinite(multiplier)) throw new Error('Missing scratch multiplier');
  const prizeTier = !huCount ? 'NONE' : multiplier >= 50 ? 'SUPER' : multiplier >= 35 ? 'HUGE' : multiplier >= 20 ? 'BIG' : 'NORMAL';
  return { huCount, multiplier, prizeTier };
}
export function kindOf(table) { return Number(table.roomType) === 63 ? 'ggl2' : 'ggl1'; }
export function publicTicket(ticket) { return { serialFull: ticket.serialFull, faceValue: ticket.faceValue, gglKind: ticket.kind.toUpperCase() }; }
