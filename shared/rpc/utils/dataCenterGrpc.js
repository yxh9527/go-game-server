import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const protoDir = path.join(here, "../proto");

function unary(client, method, req) {
  return new Promise((resolve, reject) => {
    client[method](req, (err, resp) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(resp);
    });
  });
}

let cached = null;
export function closeDataCenterClient(){cached?.close();}

export async function getDataCenterClient() {
  if (cached) {
    return cached;
  }
  const grpc = await import("@grpc/grpc-js");
  const protoLoader = await import("@grpc/proto-loader");
  const address = String(env.config.data_center || env.config.dataCenter || "127.0.0.1:50051");
  const def = protoLoader.loadSync(path.join(protoDir, "datacenter.proto"), {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [protoDir],
  });
  const proto = grpc.loadPackageDefinition(def);
  const Service = proto.datacenter?.DataCenterService;
  if (!Service) {
    throw new Error("datacenter.DataCenterService not found");
  }
  const client = new Service(address, grpc.credentials.createInsecure());
  cached = {
    authenticate(req) {
      return unary(client, "Authenticate", req);
    },
    getLoginData(req) {
      return unary(client, "GetLoginData", req);
    },
    validateToken(req) {
      return unary(client, "ValidateToken", req);
    },
    getPlayer(req) {
      return unary(client, "GetPlayer", req);
    },
    getRecords(req) {
      return unary(client, "GetRecords", req);
    },
    getRecordDetail(req) {
      return unary(client, "GetRecordDetail", req);
    },
    close() {
      client.close?.();
      cached = null;
    },
  };
  return cached;
}
