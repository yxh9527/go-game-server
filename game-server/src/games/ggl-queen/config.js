import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { DENOMINATIONS, WIN_MULTIPLIERS } = await rel(import.meta.url, '../ggl-core/rules.js', v);
export default {
  id: "ggl-queen",
  name: "赏金女王",
  kind: "slots",
  roomTypes: [63],
  confRoomType: "sjnv",
  gameName: "刮刮乐",
  title: "赏金女王",
  defaultConfigId: 6301,
  defaultRoomIndex: 26,
  defaultMaxBet: 100000000,
  maskSize: 20,
  winMultipliers: WIN_MULTIPLIERS,
  denominations: DENOMINATIONS,
};
