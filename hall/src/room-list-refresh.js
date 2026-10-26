// The supplied hall's room-list component polls only hundred/slots/fish games.
// Reuse its existing React effect for any op=38 page; keep op=35 tournaments
// on their existing refresh lifecycle. Original static files stay untouched.
const LEGACY_GUARD = "if((t<1e3||t>1004)&&!(0,o.ir)(t))return;";
const COMMON_GUARD = "if(Number((0,s.Tx)(t,a)?.op)!==38)return;";
const REQUEST = "(0,c.s6)(n,{gameType:t,subTypeIndex:a})";

export function adaptRoomListRefresh(source) {
  if (source.split(LEGACY_GUARD).length !== 2 || source.split(REQUEST).length !== 2) {
    throw new Error("Hall room-list refresh layout changed; verify the new client before adapting it");
  }
  return source.replace(LEGACY_GUARD, COMMON_GUARD)
    .replace(REQUEST, "(0,c.s6)(n,{gameType:t,subTypeIndex:a,silent:!0})");
}
