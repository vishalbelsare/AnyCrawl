CREATE TABLE "monitor_checks" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"monitor_uuid" uuid NOT NULL,
	"job_uuid" uuid,
	"sequence_number" integer NOT NULL,
	"monitor_revision" integer NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result_status" text,
	"source_error" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "monitor_notifications" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"monitor_uuid" uuid NOT NULL,
	"check_uuid" uuid NOT NULL,
	"change_uuid" uuid,
	"idempotency_key" text NOT NULL,
	"channel" text NOT NULL,
	"event_type" text NOT NULL,
	"recipient" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "monitor_notifications_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "monitor_changes" ADD COLUMN "check_uuid" uuid;--> statement-breakpoint
ALTER TABLE "monitor_changes" ADD COLUMN "notification_status" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_snapshots" ADD COLUMN "check_uuid" uuid;--> statement-breakpoint
ALTER TABLE "monitor_snapshots" ADD COLUMN "monitor_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_snapshots" ADD COLUMN "sequence_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_snapshots" ADD COLUMN "content_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "monitor_notification_uuid" uuid;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD CONSTRAINT "monitor_checks_uuid_task_executions_uuid_fk" FOREIGN KEY ("uuid") REFERENCES "public"."task_executions"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD CONSTRAINT "monitor_checks_monitor_uuid_monitors_uuid_fk" FOREIGN KEY ("monitor_uuid") REFERENCES "public"."monitors"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD CONSTRAINT "monitor_checks_job_uuid_jobs_uuid_fk" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_notifications" ADD CONSTRAINT "monitor_notifications_monitor_uuid_monitors_uuid_fk" FOREIGN KEY ("monitor_uuid") REFERENCES "public"."monitors"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_notifications" ADD CONSTRAINT "monitor_notifications_check_uuid_monitor_checks_uuid_fk" FOREIGN KEY ("check_uuid") REFERENCES "public"."monitor_checks"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_notifications" ADD CONSTRAINT "monitor_notifications_change_uuid_monitor_changes_uuid_fk" FOREIGN KEY ("change_uuid") REFERENCES "public"."monitor_changes"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_checks_active_uidx" ON "monitor_checks" USING btree ("monitor_uuid") WHERE "monitor_checks"."state" IN ('pending', 'ready', 'processing');--> statement-breakpoint
CREATE INDEX "monitor_checks_due_idx" ON "monitor_checks" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "monitor_checks_monitor_idx" ON "monitor_checks" USING btree ("monitor_uuid","sequence_number");--> statement-breakpoint
CREATE INDEX "monitor_notifications_due_idx" ON "monitor_notifications" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "monitor_notifications_change_idx" ON "monitor_notifications" USING btree ("change_uuid");--> statement-breakpoint
CREATE INDEX "monitor_notifications_monitor_idx" ON "monitor_notifications" USING btree ("monitor_uuid","created_at");--> statement-breakpoint
CREATE INDEX "monitor_snapshots_revision_idx" ON "monitor_snapshots" USING btree ("monitor_uuid","monitor_revision","url","sequence_number");--> statement-breakpoint
ALTER TABLE "monitor_changes" ADD CONSTRAINT "monitor_changes_check_uuid_unique" UNIQUE("check_uuid");--> statement-breakpoint
ALTER TABLE "monitor_snapshots" ADD CONSTRAINT "monitor_snapshots_check_uuid_unique" UNIQUE("check_uuid");