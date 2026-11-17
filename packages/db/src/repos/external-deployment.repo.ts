import { and, asc, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { externalDeploymentOperation, externalDeploymentTarget } from "../schema";

export type ExternalDeploymentTarget = typeof externalDeploymentTarget.$inferSelect;
export type NewExternalDeploymentTarget = typeof externalDeploymentTarget.$inferInsert;
export type ExternalDeploymentOperation = typeof externalDeploymentOperation.$inferSelect;
export type NewExternalDeploymentOperation = typeof externalDeploymentOperation.$inferInsert;

/** Organization-scoped persistence for provider targets and durable operations. */
export function createExternalDeploymentRepo(db: Database) {
  return {
    async listOperations(organizationId: string, targetId?: string, limit = 100): Promise<ExternalDeploymentOperation[]> {
      return db.query.externalDeploymentOperation.findMany({
        where: and(
          eq(externalDeploymentOperation.organizationId, organizationId),
          inArray(externalDeploymentOperation.operation, ["apply", "observe", "destroy"]),
          targetId ? eq(externalDeploymentOperation.targetId, targetId) : undefined,
        ),
        orderBy: (o, { desc }) => desc(o.createdAt),
        limit: Math.min(200, Math.max(1, limit)),
      });
    },
    async listTargets(organizationId: string): Promise<ExternalDeploymentTarget[]> {
      return db.query.externalDeploymentTarget.findMany({
        where: eq(externalDeploymentTarget.organizationId, organizationId),
        orderBy: (t, { asc }) => asc(t.displayName),
      });
    },

    async findTargetById(
      organizationId: string,
      id: string,
    ): Promise<ExternalDeploymentTarget | undefined> {
      return db.query.externalDeploymentTarget.findFirst({
        where: and(
          eq(externalDeploymentTarget.organizationId, organizationId),
          eq(externalDeploymentTarget.id, id),
        ),
      });
    },

    async findTargetByFingerprint(
      organizationId: string,
      fingerprint: string,
    ): Promise<ExternalDeploymentTarget | undefined> {
      return db.query.externalDeploymentTarget.findFirst({
        where: and(
          eq(externalDeploymentTarget.organizationId, organizationId),
          eq(externalDeploymentTarget.fingerprint, fingerprint),
        ),
      });
    },

    async createTarget(
      data: Omit<NewExternalDeploymentTarget, "id" | "createdAt" | "updatedAt">,
    ): Promise<ExternalDeploymentTarget> {
      const row = { id: generateId("target"), ...data };
      await db.insert(externalDeploymentTarget).values(row);
      const created = await this.findTargetById(data.organizationId, row.id);
      if (!created) throw new Error("external deployment target insert did not persist");
      return created;
    },

    async updateTarget(
      organizationId: string,
      id: string,
      patch: Partial<
        Pick<
          NewExternalDeploymentTarget,
          "displayName" | "providerIdentity" | "resource" | "capabilities" | "status" | "lastPreflightAt" | "lastError"
        >
      >,
    ): Promise<ExternalDeploymentTarget | undefined> {
      await db
        .update(externalDeploymentTarget)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(externalDeploymentTarget.organizationId, organizationId),
            eq(externalDeploymentTarget.id, id),
          ),
        );
      return this.findTargetById(organizationId, id);
    },

    async removeTarget(organizationId: string, id: string): Promise<void> {
      await db
        .delete(externalDeploymentTarget)
        .where(
          and(
            eq(externalDeploymentTarget.organizationId, organizationId),
            eq(externalDeploymentTarget.id, id),
          ),
        );
    },

    async findOperationById(
      organizationId: string,
      id: string,
    ): Promise<ExternalDeploymentOperation | undefined> {
      return db.query.externalDeploymentOperation.findFirst({
        where: and(
          eq(externalDeploymentOperation.organizationId, organizationId),
          eq(externalDeploymentOperation.id, id),
        ),
      });
    },

    async findOperationByIdempotency(
      organizationId: string,
      idempotencyKey: string,
    ): Promise<ExternalDeploymentOperation | undefined> {
      return db.query.externalDeploymentOperation.findFirst({
        where: and(
          eq(externalDeploymentOperation.organizationId, organizationId),
          eq(externalDeploymentOperation.idempotencyKey, idempotencyKey),
        ),
      });
    },

    async createOperation(
      data: Omit<NewExternalDeploymentOperation, "id" | "createdAt" | "updatedAt">,
    ): Promise<ExternalDeploymentOperation> {
      const existing = await this.findOperationByIdempotency(
        data.organizationId,
        data.idempotencyKey,
      );
      if (existing) return existing;
      const row = { id: generateId("extop"), ...data };
      await db.insert(externalDeploymentOperation).values(row).onConflictDoNothing({
        target: [externalDeploymentOperation.organizationId, externalDeploymentOperation.idempotencyKey],
      });
      const created = await this.findOperationByIdempotency(data.organizationId, data.idempotencyKey);
      if (!created) throw new Error("external deployment operation insert did not persist");
      return created;
    },

    async updateOperation(
      organizationId: string,
      id: string,
      patch: Partial<
        Pick<
          NewExternalDeploymentOperation,
          | "operation"
          | "status"
          | "providerRequestId"
          | "providerResourceId"
          | "providerStatus"
          | "observed"
          | "errorCode"
          | "errorMessage"
          | "leaseOwner"
          | "leaseUntil"
          | "reconcileAfter"
          | "startedAt"
          | "finishedAt"
        >
      >,
    ): Promise<ExternalDeploymentOperation | undefined> {
      await db
        .update(externalDeploymentOperation)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(externalDeploymentOperation.organizationId, organizationId),
            eq(externalDeploymentOperation.id, id),
          ),
        );
      return this.findOperationById(organizationId, id);
    },

    async updateObservation(
      organizationId: string,
      id: string,
      expectedUpdatedAt: Date,
      expectedOperation: string,
      patch: Partial<Pick<NewExternalDeploymentOperation, "operation" | "status" | "providerRequestId" | "providerResourceId" | "providerStatus" | "observed" | "errorCode" | "errorMessage" | "leaseOwner" | "leaseUntil" | "reconcileAfter" | "finishedAt">>,
    ): Promise<ExternalDeploymentOperation | undefined> {
      await db.update(externalDeploymentOperation).set({ ...patch, updatedAt: new Date() }).where(and(
        eq(externalDeploymentOperation.organizationId, organizationId),
        eq(externalDeploymentOperation.id, id),
        eq(externalDeploymentOperation.updatedAt, expectedUpdatedAt),
        eq(externalDeploymentOperation.operation, expectedOperation),
      ));
      return this.findOperationById(organizationId, id);
    },

    async listReconciliationDue(
      organizationId: string,
      now = new Date(),
      limit = 100,
    ): Promise<ExternalDeploymentOperation[]> {
      return db.query.externalDeploymentOperation.findMany({
        where: and(
          eq(externalDeploymentOperation.organizationId, organizationId),
          eq(externalDeploymentOperation.status, "reconciling"),
          or(
            sql`${externalDeploymentOperation.reconcileAfter} IS NULL`,
            lte(externalDeploymentOperation.reconcileAfter, now),
          ),
        ),
        orderBy: [asc(externalDeploymentOperation.reconcileAfter), asc(externalDeploymentOperation.createdAt)],
        limit,
      });
    },

    async listOperationsByTarget(
      organizationId: string,
      targetId: string,
      limit = 100,
    ): Promise<ExternalDeploymentOperation[]> {
      return db.query.externalDeploymentOperation.findMany({
        where: and(
          eq(externalDeploymentOperation.organizationId, organizationId),
          eq(externalDeploymentOperation.targetId, targetId),
        ),
        orderBy: (o, { desc }) => desc(o.createdAt),
        limit,
      });
    },
  };
}
