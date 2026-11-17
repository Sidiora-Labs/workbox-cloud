import { WorkboxHostOperationSchemas } from "@repo/contracts";
import type { Authorization } from "./authorization";
import { createScopedOperations, type ScopedServices, type PlatformScopedOperations } from "./resource-operations";
export type WorkboxHostDependencies=ScopedServices<typeof WorkboxHostOperationSchemas>;
export type PlatformWorkboxHostOperations=PlatformScopedOperations<typeof WorkboxHostOperationSchemas>;
export const createWorkboxHostOperations=(authorization:Authorization,dependencies?:WorkboxHostDependencies)=>createScopedOperations(WorkboxHostOperationSchemas,authorization,"server",dependencies);
