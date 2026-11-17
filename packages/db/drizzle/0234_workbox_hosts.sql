CREATE TABLE "workbox_host" (
 "id" text PRIMARY KEY NOT NULL, "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
 "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE RESTRICT,
 "name" text NOT NULL, "rootfs" text NOT NULL, "version" text NOT NULL, "status" text NOT NULL,
 "connection_id" text REFERENCES "credential"("id") ON DELETE SET NULL,
 "token_enc" text NOT NULL, "host_identity" text NOT NULL, "port" integer NOT NULL,
 "progress" jsonb DEFAULT '[]'::jsonb NOT NULL, "error" text, "generation" integer DEFAULT 1 NOT NULL,
 "lease_until" timestamp, "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL,
 CONSTRAINT "workbox_host_port_check" CHECK ("port" BETWEEN 1024 AND 65535),
 CONSTRAINT "workbox_host_rootfs_check" CHECK ("rootfs" IN ('minimal','agents')),
 CONSTRAINT "workbox_host_status_check" CHECK ("status" IN ('queued','installing','ready','stopped','failed','removing','removed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workbox_host_server" ON "workbox_host"("server_id");
