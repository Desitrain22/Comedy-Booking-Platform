ALTER TABLE `comedians` ADD `phone` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `guide_dismissed_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `guide_completed_at` integer;