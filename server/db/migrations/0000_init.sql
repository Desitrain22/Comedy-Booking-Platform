CREATE TABLE `availability` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`comedian_id` integer NOT NULL,
	`date` text NOT NULL,
	`start_min` integer NOT NULL,
	`end_min` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`comedian_id`) REFERENCES `comedians`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `availability_comedian_date_uq` ON `availability` (`comedian_id`,`date`);--> statement-breakpoint
CREATE INDEX `availability_date_idx` ON `availability` (`date`);--> statement-breakpoint
CREATE TABLE `availability_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`kind` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`audience` text DEFAULT 'all' NOT NULL,
	`recipient_count` integer DEFAULT 0 NOT NULL,
	`sent_by_id` integer,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`sent_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `availability_requests_month_idx` ON `availability_requests` (`month`);--> statement-breakpoint
CREATE TABLE `availability_submissions` (
	`comedian_id` integer NOT NULL,
	`month` text NOT NULL,
	`submitted_at` integer NOT NULL,
	PRIMARY KEY(`comedian_id`, `month`),
	FOREIGN KEY (`comedian_id`) REFERENCES `comedians`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` integer NOT NULL,
	`comedian_id` integer NOT NULL,
	`position` integer NOT NULL,
	`override_unavailable` integer DEFAULT false NOT NULL,
	`booked_by_id` integer,
	`confirmation_sent_at` integer,
	`confirmed_at` integer,
	`confirmed_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`comedian_id`) REFERENCES `comedians`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`booked_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_show_position_uq` ON `bookings` (`show_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_show_comedian_uq` ON `bookings` (`show_id`,`comedian_id`);--> statement-breakpoint
CREATE INDEX `bookings_comedian_idx` ON `bookings` (`comedian_id`);--> statement-breakpoint
CREATE TABLE `comedian_tags` (
	`comedian_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`comedian_id`, `tag_id`),
	FOREIGN KEY (`comedian_id`) REFERENCES `comedians`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comedian_tags_tag_idx` ON `comedian_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `comedians` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`headshot_url` text DEFAULT '' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comedians_email_unique` ON `comedians` (`email`);--> statement-breakpoint
CREATE TABLE `email_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`to_email` text NOT NULL,
	`subject` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`comedian_id` integer,
	`body_html` text DEFAULT '' NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`comedian_id`) REFERENCES `comedians`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `email_log_created_idx` ON `email_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `email_log_comedian_idx` ON `email_log` (`comedian_id`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`key` text PRIMARY KEY NOT NULL,
	`ran_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `locations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`color` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`comedian_id` integer NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`comedian_id`) REFERENCES `comedians`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `login_codes_comedian_idx` ON `login_codes` (`comedian_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`comedian_id` integer NOT NULL,
	`author_id` integer,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`comedian_id`) REFERENCES `comedians`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notes_comedian_idx` ON `notes` (`comedian_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_subject_idx` ON `sessions` (`kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`club_name` text DEFAULT '' NOT NULL,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`app_url` text DEFAULT '' NOT NULL,
	`all_night_start_min` integer DEFAULT 1140 NOT NULL,
	`all_night_end_min` integer DEFAULT 1380 NOT NULL,
	`smtp_host` text DEFAULT '' NOT NULL,
	`smtp_port` integer DEFAULT 587 NOT NULL,
	`smtp_secure` integer DEFAULT false NOT NULL,
	`smtp_user` text DEFAULT '' NOT NULL,
	`smtp_pass` text DEFAULT '' NOT NULL,
	`from_name` text DEFAULT '' NOT NULL,
	`from_email` text DEFAULT '' NOT NULL,
	`reply_to` text DEFAULT '' NOT NULL,
	`confirmations_enabled` integer DEFAULT true NOT NULL,
	`confirmation_day` integer DEFAULT 1 NOT NULL,
	`confirmation_time_min` integer DEFAULT 600 NOT NULL,
	`setup_complete` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "settings_singleton" CHECK("settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `shows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`location_id` integer NOT NULL,
	`date` text NOT NULL,
	`start_min` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`slot_count` integer DEFAULT 6 NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shows_date_idx` ON `shows` (`date`);--> statement-breakpoint
CREATE INDEX `shows_location_date_idx` ON `shows` (`location_id`,`date`,`start_min`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`comedian_id` integer NOT NULL,
	`purpose` text NOT NULL,
	`week_start` text,
	`redirect_to` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`comedian_id`) REFERENCES `comedians`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_token_hash_unique` ON `tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `tokens_comedian_idx` ON `tokens` (`comedian_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text,
	`role` text DEFAULT 'booker' NOT NULL,
	`invite_token_hash` text,
	`invite_expires_at` integer,
	`created_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_invite_token_hash_unique` ON `users` (`invite_token_hash`);