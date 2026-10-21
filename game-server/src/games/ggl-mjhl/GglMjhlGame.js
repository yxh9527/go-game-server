import { GglGame } from "../ggl-core/GglGame.js";
import config from "./config.js";

export class GglMjhlGame extends GglGame {
  constructor() {
    super(config);
  }
}

export default new GglMjhlGame();
