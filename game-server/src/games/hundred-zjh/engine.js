import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { createBairenEngine } = await rel(import.meta.url, '../../core/bairen-engine.js', v);
const { default: adapter } = await rel(import.meta.url, './hand.js', v);
export const { PHASE, historyList, historyDetail, configuredOdds, roadSnapshot, createHand, visibleCards, resultCards, betAreaTotals, roomSnapshot, beginRound, acceptBet, settleRound, tick } = createBairenEngine(adapter);
