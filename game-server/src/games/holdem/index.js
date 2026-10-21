import { rel } from "../../rel.js";

const v = new URL(import.meta.url).searchParams.get("v") || "0";
export default (await rel(import.meta.url, "./HoldemGame.js", v)).default;
