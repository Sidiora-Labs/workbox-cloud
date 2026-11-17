import { pgTable, text, timestamp, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./organization";
import { servers } from "./servers";
import { credential } from "./credential";
type Progress = {id:string;label:string;status:"pending"|"running"|"completed"|"failed";message?:string}[];
export const workboxHost = pgTable("workbox_host", {
  id:text("id").primaryKey(), organizationId:text("organization_id").notNull().references(()=>organization.id,{onDelete:"cascade"}),
  serverId:text("server_id").notNull().references(()=>servers.id,{onDelete:"restrict"}),
  name:text("name").notNull(),rootfs:text("rootfs").notNull(),version:text("version").notNull(), status:text("status").notNull(),
  connectionId:text("connection_id").references(()=>credential.id,{onDelete:"set null"}),
  tokenEnc:text("token_enc").notNull(),hostIdentity:text("host_identity").notNull(),port:integer("port").notNull(),
  progress:jsonb("progress").$type<Progress>().notNull().default([]),error:text("error"),
  generation:integer("generation").notNull().default(1),leaseUntil:timestamp("lease_until"),
  createdAt:timestamp("created_at").notNull().defaultNow(),updatedAt:timestamp("updated_at").notNull().defaultNow(),
},table=>[uniqueIndex("uq_workbox_host_server").on(table.serverId)]);
export type WorkboxHostRecord = typeof workboxHost.$inferSelect;
