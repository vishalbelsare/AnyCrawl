CREATE TABLE `monitor_checks` (
	`uuid` text PRIMARY KEY NOT NULL,
	`monitor_uuid` text NOT NULL,
	`job_uuid` text,
	`sequence_number` integer NOT NULL,
	`monitor_revision` integer NOT NULL,
	`config_snapshot` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`result_status` text,
	`source_error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`uuid`) REFERENCES `task_executions`(`uuid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`monitor_uuid`) REFERENCES `monitors`(`uuid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_uuid`) REFERENCES `jobs`(`uuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_checks_active_uidx` ON `monitor_checks` (`monitor_uuid`) WHERE "monitor_checks"."state" IN ('pending', 'ready', 'processing');--> statement-breakpoint
CREATE INDEX `monitor_checks_due_idx` ON `monitor_checks` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `monitor_checks_monitor_idx` ON `monitor_checks` (`monitor_uuid`,`sequence_number`);--> statement-breakpoint
CREATE TABLE `monitor_notifications` (
	`uuid` text PRIMARY KEY NOT NULL,
	`monitor_uuid` text NOT NULL,
	`check_uuid` text NOT NULL,
	`change_uuid` text,
	`idempotency_key` text NOT NULL,
	`channel` text NOT NULL,
	`event_type` text NOT NULL,
	`recipient` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`monitor_uuid`) REFERENCES `monitors`(`uuid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`check_uuid`) REFERENCES `monitor_checks`(`uuid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`change_uuid`) REFERENCES `monitor_changes`(`uuid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_notifications_idempotency_key_unique` ON `monitor_notifications` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `monitor_notifications_due_idx` ON `monitor_notifications` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `monitor_notifications_change_idx` ON `monitor_notifications` (`change_uuid`);--> statement-breakpoint
CREATE INDEX `monitor_notifications_monitor_idx` ON `monitor_notifications` (`monitor_uuid`,`created_at`);--> statement-breakpoint
ALTER TABLE `monitor_changes` ADD `check_uuid` text;--> statement-breakpoint
ALTER TABLE `monitor_changes` ADD `notification_status` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_changes_check_uuid_unique` ON `monitor_changes` (`check_uuid`);--> statement-breakpoint
CREATE INDEX `monitor_changes_monitor_idx` ON `monitor_changes` (`monitor_uuid`,`created_at`);--> statement-breakpoint
ALTER TABLE `monitor_snapshots` ADD `check_uuid` text;--> statement-breakpoint
ALTER TABLE `monitor_snapshots` ADD `monitor_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitor_snapshots` ADD `sequence_number` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitor_snapshots` ADD `content_complete` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_snapshots_check_uuid_unique` ON `monitor_snapshots` (`check_uuid`);--> statement-breakpoint
CREATE INDEX `monitor_snapshots_revision_idx` ON `monitor_snapshots` (`monitor_uuid`,`monitor_revision`,`url`,`sequence_number`);--> statement-breakpoint
ALTER TABLE `monitors` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD `monitor_notification_uuid` text;