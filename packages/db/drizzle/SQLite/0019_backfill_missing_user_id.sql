ALTER TABLE `jobs` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `request_log` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `template_executions` ADD `user_id` text;
