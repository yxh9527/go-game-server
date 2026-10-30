const copy = value => structuredClone(value);
export function createDevTournamentStore(runtime) {
  const resident = runtime.tournamentMemory ||= { schedules: new Map(), occurrences: new Map(), docs: new Map(), queue: Promise.resolve() };
  const base = runtime.store;
  function locked(work) {
    const task = resident.queue.catch(()=>{}).then(work);
    resident.queue = task.catch(()=>{});
    return task;
  }
  return {
    async listSchedules() { return [...resident.schedules.values()].map(copy); },
    async saveSchedule(id, row) {
      return locked(async()=>{
        if (id && !resident.schedules.has(Number(id))) throw new Error('schedule not found');
        if(id&&Number(resident.schedules.get(Number(id)).agent_id)!==Number(row.agent_id))throw Object.assign(new Error('不能修改排期所属代理'),{status:403});
        id = Number(id) || Math.max(0,...resident.schedules.keys()) + 1;
        const saved = { ...copy(row), id }; resident.schedules.set(id,saved); return copy(saved);
      });
    },
    async ensureOccurrence(schedule, slot, row) {
      return locked(async()=>{
        const current=resident.schedules.get(schedule.id);
        if (!current?.enabled) return null;
        if(['agent_id','payload','schedule_kind','timezone','daily_time','start_time'].some(k=>String(current[k])!==String(schedule[k])))return null;
        if (resident.occurrences.has(slot.key)) return base.getMatch(resident.occurrences.get(slot.key));
        const saved = await base.insertMatch(row);
        resident.occurrences.set(slot.key,saved.id); return saved;
      });
    },
    async withMatch(id, work) {
      return locked(async()=>{
        const row = await base.getMatch(id); if (!row) return null;
        const state = copy(resident.docs.get(Number(id)) || { registrations: {}, outbox: [] });
        const result = await work({ row, state });
        await base.updateMatch(id,row); resident.docs.set(Number(id),state); return copy(result);
      });
    },
  };
}
