import type { WorkboxHostDependencies } from "../../../workbox-hosts";
import { listWorkboxHosts, getWorkboxHost, preflightWorkboxHost, createWorkboxHost, actOnWorkboxHost } from "./service";
export const workboxHostDependencies:WorkboxHostDependencies={
  list:ctx=>listWorkboxHosts(ctx),get:(ctx,input)=>getWorkboxHost(ctx,input.id),
  preflight:(ctx,input)=>preflightWorkboxHost(ctx,input.serverId),create:(ctx,input)=>createWorkboxHost(ctx,input),
  action:(ctx,input)=>actOnWorkboxHost(ctx,input.id,input),
};
