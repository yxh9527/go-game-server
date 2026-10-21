import { PUSH } from "../messages.js";

export class GameBase {
  constructor(config) {
    this.config = config;
  }

  get id() {
    return this.config.id;
  }

  get kind() {
    return this.config.kind;
  }

  get roomTypes() {
    return this.config.roomTypes;
  }

  createTable(roomId, roomType, roomRow) {
    return {
      gameId: this.id,
      kind: this.kind,
      roomId: Number(roomId),
      roomType: Number(roomType) || this.roomTypes[0],
      cfg: roomRow || {},
      config: this.config,
    };
  }

  buildConf(table) {
    return {
      roomType: this.config.confRoomType,
      playMode: Number(table.cfg?.play_mode || 0),
    };
  }

  onJoin(ctx) {
    ctx.send(PUSH.ROOM_TYPE_RESULT, {
      roomId: ctx.table.roomId,
      roomType: ctx.table.roomType,
      conf: this.buildConf(ctx.table),
    });
  }

  onLoginRoom(_ctx) {}

  onMessage(_ctx, _msgid, _payload) {}

  tick(_ctx) {}

  onLeave(_ctx) {
    return 0;
  }
}
