// Serialized into the hall's shared webpack chunk by scripts/update-hall-room-status.js.
// Keep this factory self-contained so nginx can serve the finished static files.
export function hallCardImagePath(card) {
  if (card == null) return undefined;
  return card === -1 ? '/l01/img/cards/small/card-back-blue.png' : '/l01/img/cards/small/' + card + '.webp';
}

export function createRoomStatusView(React) {
  const listeners = new Set();
  let timer;
  function subscribe(listener) {
    listeners.add(listener);
    if (!timer) timer = window.setInterval(() => {
      const now = Date.now();
      for (const update of listeners) update(now);
    }, 250);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) { window.clearInterval(timer); timer = undefined; }
    };
  }
  function label(room) {
    const state = Number(room.gameStatus), type = Number(room.roomType);
    if (state === 2) return '下注中';
    if (type >= 53 && type <= 57) {
      return ({ '-1': '等待开局', 0: '等待开局', 1: '准备中', 4: '开奖中', 6: '结算中', 10: '路单统计' })[state];
    }
    if (type === 58 || type === 59) {
      return ({ 0: '等待开局', 1: '发牌中', 3: '停止下注', 4: '开奖中', 5: '开奖中', 6: '结算中', 7: '等待下局', 8: '洗牌中', 9: '补牌中' })[state];
    }
    if (type === 60) {
      return ({ 0: '等待开局', 1: '发牌中', 3: '停止下注', 4: '开奖中', 5: '比牌中',
        6: '结算中', 7: '等待下局', 8: '洗牌中' })[state];
    }
    return ({ 0: '等待开局', 1: '发牌中', 4: '开奖中', 5: '结算中', 6: '路单统计', 7: '等待下局' })[state];
  }
  return function RoomStatus({ room }) {
    const [now, setNow] = React.useState(Date.now);
    const received = React.useRef({ room, at: Date.now() });
    if (received.current.room !== room) received.current = { room, at: Date.now() };
    React.useEffect(() => subscribe(setNow), []);
    const duration = Number(room.gameStatusDuration);
    const start = Number(room.gameStatusStartTime), serverNow = Number(room.serverNow);
    const remaining = Math.max(0, start + duration - serverNow - Math.max(0, now - received.current.at));
    const seconds = Math.ceil(remaining / 1000);
    const name = label(room);
    const valid = [start, duration, serverNow].every(Number.isFinite) && duration >= 0;
    const text = !name || !valid || (duration > 0 && !seconds) ? '状态同步中'
      : name + (duration > 0 ? ' ' + seconds + 's' : '');
    return React.createElement('span', {
      'data-room-status': String(room.roomId || room.gameRoomConfigId),
      'data-game-status': String(room.gameStatus),
      style: { position: 'absolute', right: '.10rem', top: '.05rem', zIndex: 2,
        borderRadius: '.06rem', padding: '.025rem .07rem', fontSize: '.20rem', lineHeight: '1.3',
        background: 'rgba(18,20,29,.88)', color: room.gameStatus === 2 ? '#70e0a5' : '#f1d89a',
        pointerEvents: 'none', whiteSpace: 'nowrap' },
    }, text);
  };
}
