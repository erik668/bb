PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_thread_supervisor_bindings` (
	`child_thread_id` text PRIMARY KEY NOT NULL,
	`supervisor_id` text NOT NULL,
	`task_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`child_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_thread_supervisor_bindings`("child_thread_id", "supervisor_id", "task_id", "created_at") SELECT "child_thread_id", "supervisor_id", "task_id", "created_at" FROM `thread_supervisor_bindings`;--> statement-breakpoint
DROP TABLE `thread_supervisor_bindings`;--> statement-breakpoint
ALTER TABLE `__new_thread_supervisor_bindings` RENAME TO `thread_supervisor_bindings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;