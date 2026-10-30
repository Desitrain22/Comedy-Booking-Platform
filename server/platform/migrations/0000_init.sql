CREATE TABLE `admin_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admin_email` text NOT NULL,
	`club_id` integer,
	`action` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `admin_events_club_idx` ON `admin_events` (`club_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `admin_login_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_login_codes_email_idx` ON `admin_login_codes` (`email`,`created_at`);--> statement-breakpoint
CREATE TABLE `admin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_sessions_expires_idx` ON `admin_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `clubs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`status_reason` text DEFAULT '' NOT NULL,
	`status_changed_at` integer,
	`owner_name` text NOT NULL,
	`owner_email` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clubs_slug_unique` ON `clubs` (`slug`);--> statement-breakpoint
CREATE INDEX `clubs_status_idx` ON `clubs` (`status`);--> statement-breakpoint
CREATE TABLE `handoffs` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`club_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `platform_email_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`to_email` text NOT NULL,
	`subject` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`body_text` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `platform_email_log_created_idx` ON `platform_email_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `platform_job_runs` (
	`key` text PRIMARY KEY NOT NULL,
	`ran_at` integer NOT NULL
);
