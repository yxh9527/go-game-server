export const prodDeps = {
  manager: null,
  player: null,
  redis: null,
};

export function setProdDeps(deps) {
  Object.assign(prodDeps, deps);
}
