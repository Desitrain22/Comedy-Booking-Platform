ALTER TABLE `email_log` ADD `via` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `email_log` ADD `sender_user_id` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `settings` ADD `sender_mode` text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `smtp_host` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `smtp_port` integer DEFAULT 587 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `smtp_secure` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `smtp_user` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `smtp_pass` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `smtp_from_email` text DEFAULT '' NOT NULL;