import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { DENOMINATIONS, WIN_MULTIPLIERS } = await rel(import.meta.url, '../ggl-core/rules.js', v);
export default {
  id: "ggl-mjhl",
  name: "麻将胡了",
  kind: "slots",
  roomTypes: [61],
  confRoomType: "mjhl",
  gameName: "刮刮乐",
  title: "麻将胡了",
  defaultConfigId: 6101,
  defaultRoomIndex: 26,
  defaultMaxBet: 100000000,
  maskSize: 20,
  winMultipliers: WIN_MULTIPLIERS,
  denominations: DENOMINATIONS,
};
