import express from "express";
import { rel } from "./rel.js";

export async function createApp(runtime) {
  const v = runtime.hotVersion;
  if(runtime.env==='prod'){
    const {refreshDataAccess}=await rel(import.meta.url,'../../shared/rpc/adapters/rpcAdapter.js',v);
    await refreshDataAccess(runtime);
  }
  const { createMatchService } = await rel(import.meta.url, "./services/match.js", v);
  const { createMetaService } = await rel(import.meta.url, "./services/meta.js", v);
  const { createAdminScope } = await rel(import.meta.url, './admin-scope.js', v);
  const matches = await createMatchService(runtime);
  const meta = await createMetaService(runtime);
  const { createTournaments } = await rel(import.meta.url, './tournaments.js', v);
  const tournaments = await createTournaments(runtime, matches);
  if (!runtime.tournamentTables || runtime.managedTournamentTables) {
    const { createTournamentTables } = await rel(import.meta.url, './tables.js', v);
    runtime.tournamentTables = await createTournamentTables(runtime);
    runtime.managedTournamentTables = true;
  }

  const app = express();
  app.locals.tournaments=tournaments;
  app.use(express.json({ limit: "2mb" }));
  app.get("/health", (_req, res) => {
    res.json({ code: 0, msg: "ok", data: { service: "match", env: runtime.env, hotVersion: v } });
  });

  const admin = express.Router();
  admin.use(createAdminScope(runtime));

  const wrap = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  admin.use('/matches/:id', wrap(async (req,_res,next) => {
    const row=await matches.get(Number(req.params.id));
    if(Number(row.agent_id)!==req.adminAgentId)throw Object.assign(new Error('比赛不存在'),{status:404});
    req.adminMatch=row;
    next();
  }));

  admin.get("/matches", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: (await matches.list()).filter(row=>Number(row.agent_id)===req.adminAgentId) });
  }));
  admin.get("/matches/:id", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: req.adminMatch });
  }));
  admin.post("/matches", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: await matches.create({...req.body,agent_id:req.adminAgentId}) });
  }));
  admin.put("/matches/:id", wrap(async (req, res) => {
    const {agent_id,...patch}=req.body||{};
    res.json({ code: 0, msg: "ok", data: await tournaments.update(Number(req.params.id), patch) });
  }));
  admin.put("/matches/:id/state", wrap(async (req, res) => {
    const to = Number(req.body?.state);
    if (to === 4) {
      res.json({ code: 0, msg: 'ok', data: await tournaments.cancel(Number(req.params.id)) });
      return;
    }
    if (to !== 1) throw Object.assign(new Error('开赛、比赛结束由调度与真实牌局结果驱动'), { status: 409 });
    res.json({ code: 0, msg: "ok", data: await tournaments.openRegistration(Number(req.params.id)) });
  }));

  admin.get('/schedules', wrap(async (req,res) => res.json({code:0,msg:'ok',data:(await tournaments.listSchedules()).filter(row=>Number(row.agent_id)===req.adminAgentId)})));
  admin.post('/schedules', wrap(async (req,res) => res.json({code:0,msg:'ok',data:await tournaments.saveSchedule(0,{...req.body,agent_id:req.adminAgentId})})));
  admin.put('/schedules/:id', wrap(async (req,res) => {
    const row=(await tournaments.listSchedules()).find(row=>Number(row.id)===Number(req.params.id)&&Number(row.agent_id)===req.adminAgentId);
    if(!row)throw Object.assign(new Error('排期不存在'),{status:404});
    res.json({code:0,msg:'ok',data:await tournaments.saveSchedule(Number(req.params.id),{...req.body,agent_id:req.adminAgentId})});
  }));
  admin.get('/matches/:id/runtime', wrap(async (req,res) => res.json({code:0,msg:'ok',data:await tournaments.inspect(Number(req.params.id))})));
  app.post('/internal/v1/tournament', wrap(async (req,res) => {
    const body=req.body||{}, user=await tournaments.identify(body);
    if(body.action==='register') await tournaments.register(body.matchId,user);
    else if(body.action==='unregister') await tournaments.unregister(body.matchId,user);
    else if(body.action!=='snapshot') throw Object.assign(new Error('unknown tournament action'),{status:400});
    const data = await tournaments.snapshot(user);
    // Local services have separate memory buses. Production uses the existing
    // match channel and hall cache instead of querying templates per player.
    const metadata = runtime.env === 'dev' ? {
      awards: await runtime.store.listAwards(), blinds: await runtime.store.listBlinds(),
    } : undefined;
    res.set('Cache-Control','no-store').json({code:0,msg:'ok',data,metadata});
  }));

  admin.get("/tickets", wrap(async (_req, res) => {
    res.json({ code: 0, msg: "ok", data: await meta.listTickets() });
  }));
  admin.post("/tickets", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: await meta.createTicket(req.body || {}) });
  }));
  admin.put("/tickets/:id", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: await meta.updateTicket(Number(req.params.id), req.body || {}) });
  }));
  admin.get("/ticket-rates", wrap(async (_req, res) => {
    res.json({ code: 0, msg: "ok", data: await meta.listRates() });
  }));
  admin.put("/ticket-rates", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: await meta.upsertRate(req.body || {}) });
  }));
  admin.get("/awards", wrap(async (_req, res) => {
    res.json({ code: 0, msg: "ok", data: await meta.listAwards() });
  }));
  admin.post("/awards", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: await meta.createAward(req.body || {}) });
  }));
  admin.put("/awards/:id", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: await meta.updateAward(Number(req.params.id), req.body || {}) });
  }));
  admin.get("/blinds", wrap(async (_req, res) => {
    res.json({ code: 0, msg: "ok", data: await meta.listBlinds() });
  }));
  admin.post("/blinds", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: await meta.createBlinds(req.body || {}) });
  }));
  admin.put("/blinds/:id", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: await meta.updateBlinds(Number(req.params.id), req.body || {}) });
  }));

  app.use("/admin/v1", admin);
  app.use((err, _req, res, _next) => {
    const status = Number(err.status) || 500;
    if (status >= 500) {
      runtime.log.error(err);
    }
    res.status(status).json({ code: status, msg: err.message || "error" });
  });
  // One resident timer; replace its callback on reload and never restart listeners.
  if (typeof runtime.store?.listMatches === 'function' && runtime.config.tournament_scheduler !== false) {
    const loop=runtime.tournamentLoop ||= {busy:false};
    loop.work=()=>tournaments.tick();
    if(!loop.timer){loop.timer=setInterval(async()=>{
      if(loop.busy)return;loop.busy=true;
      try{await loop.work();}catch(error){runtime.log.error('tournament scheduler failed',error.message);}
      finally{loop.busy=false;}
    },1000);loop.timer.unref?.();}
  }
  return app;
}
