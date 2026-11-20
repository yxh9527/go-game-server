// Scratch 61/63 use the paid-ticket authority. Competition 101 has no cash
// settlement. Every other registered cash room must use unified Settlement.
export const CASH_FINANCE_ROOM_TYPES=Object.freeze([19,24,25,26,27,28,30,31,32,50,51,52,53,54,55,56,57,58,59,60,62]);

export function productionFinanceConfig(previous={}){
  return {...previous,provider:'lottery',room_types:[...CASH_FINANCE_ROOM_TYPES]};
}

export function validateProductionFinance(config){
  const finance=config?.finance;
  if(finance?.provider!=='lottery'||!Array.isArray(finance.room_types)
    ||finance.room_types.some(type=>!CASH_FINANCE_ROOM_TYPES.includes(type))
    ||new Set(finance.room_types).size!==CASH_FINANCE_ROOM_TYPES.length)
    throw new Error('生产现金游戏必须配置 finance.provider=lottery，room_types 必须覆盖全部现金玩法；刮刮乐使用原票务资金接口');
}
