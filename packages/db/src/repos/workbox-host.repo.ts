import { and, eq, desc } from "drizzle-orm";
import type { Database } from "../client";
import { workboxHost, type WorkboxHostRecord } from "../schema/workbox-host";
export function createWorkboxHostRepo(db: Database) {
  return {
    list: (organizationId: string) =>
      db
        .select()
        .from(workboxHost)
        .where(eq(workboxHost.organizationId, organizationId))
        .orderBy(desc(workboxHost.createdAt)),
    async find(organizationId: string, id: string) {
      return (
        await db
          .select()
          .from(workboxHost)
          .where(and(eq(workboxHost.organizationId, organizationId), eq(workboxHost.id, id)))
      )[0];
    },
    async byServer(organizationId: string, serverId: string) {
      return (
        await db
          .select()
          .from(workboxHost)
          .where(
            and(eq(workboxHost.organizationId, organizationId), eq(workboxHost.serverId, serverId)),
          )
      )[0];
    },
    async create(row: typeof workboxHost.$inferInsert) {
      return (await db.insert(workboxHost).values(row).returning())[0]!;
    },
    async update(
      organizationId: string,
      id: string,
      patch: Partial<Omit<WorkboxHostRecord, "id" | "organizationId" | "serverId" | "createdAt">>,
      generation?: number,
    ) {
      return (
        await db
          .update(workboxHost)
          .set({ ...patch, updatedAt: new Date() })
          .where(
            and(
              eq(workboxHost.organizationId, organizationId),
              eq(workboxHost.id, id),
              generation === undefined ? undefined : eq(workboxHost.generation, generation),
            ),
          )
          .returning()
      )[0];
    },
  };
}
