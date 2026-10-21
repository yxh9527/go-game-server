import express from "express";
import { rel } from "./rel.js";

export async function createApp(runtime) {
  const v = runtime.hotVersion;
  const { createMatchService } = await rel(import.meta.url, "./services/match.js", v);
  const { createMetaService } = await rel(import.meta.url, "./services/meta.js", v);
  const matches = await createMatchService(runtime);
  const meta = await createMetaService(runtime);

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.get("/health", (_req, res) => {
    res.json({ code: 0, msg: "ok", data: { service: "match", env: runtime.env, hotVersion: v } });
  });

  const admin = express.Router();
  if (runtime.config.admin_token) {
    admin.use((req, res, next) => {
      if (req.get("X-Admin-Token") !== runtime.config.admin_token) {
        res.status(403).json({ code: 403, msg: "forbidden" });
        return;
      }
      next();
    });
  }

  const wrap = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

  admin.get("/matches", wrap(async (_req, res) => {
    res.json({ code: 0, msg: "ok", data: await matches.list() });
  }));
  admin.get("/matches/:id", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: await matches.get(Number(req.params.id)) });
  }));
  admin.post("/matches", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: await matches.create(req.body || {}) });
  }));
  admin.put("/matches/:id", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: await matches.update(Number(req.params.id), req.body || {}) });
  }));
  admin.put("/matches/:id/state", wrap(async (req, res) => {
    res.json({ code: 0, msg: "ok", data: await matches.changeState(Number(req.params.id), Number(req.body?.state)) });
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
  return app;
}
