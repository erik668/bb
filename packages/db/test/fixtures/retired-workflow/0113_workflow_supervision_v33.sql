CREATE TABLE `thread_source_pins` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`pin` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `thread_supervisor_bindings` (
	`child_thread_id` text PRIMARY KEY NOT NULL,
	`supervisor_id` text NOT NULL,
	`task_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`child_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supervisor_id`) REFERENCES `thread_supervisors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `thread_supervisor_inbox` (
	`key` text PRIMARY KEY NOT NULL,
	`supervisor_id` text NOT NULL,
	`child_thread_id` text,
	`task_id` text,
	`turn_id` text,
	`kind` text NOT NULL,
	`output` text,
	`queued_message_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`supervisor_id`) REFERENCES `thread_supervisors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_supervisor_inbox_address_created_idx` ON `thread_supervisor_inbox` (`supervisor_id`,`created_at`,`key`);--> statement-breakpoint
CREATE TABLE `thread_supervisors` (
	`id` text PRIMARY KEY NOT NULL,
	`manager_thread_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`inbox_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`manager_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
