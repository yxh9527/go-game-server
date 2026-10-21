import { GglGame } from "../ggl-core/GglGame.js";
import config from "./config.js";

export class GglQueenGame extends GglGame {
  constructor() {
    super(config);
  }
}

export default new GglQueenGame();
