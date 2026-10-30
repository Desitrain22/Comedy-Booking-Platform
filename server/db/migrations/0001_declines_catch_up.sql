ALTER TABLE `bookings` ADD `declined_at` integer;--> statement-breakpoint
ALTER TABLE `bookings` ADD `decline_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `catch_up_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `allow_declines` integer DEFAULT false NOT NULL;