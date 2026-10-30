export const prodDeps = {
  redis: null,
};

export function setProdDeps(deps) {
  Object.assign(prodDeps, deps);
}
