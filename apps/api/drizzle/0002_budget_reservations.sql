CREATE TABLE "budget_reservations" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"est_usd" numeric(14, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "budget_reservations_est_check" CHECK (est_usd > 0)
);
--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_tenant_id_users_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_reservations_open_expires_idx" ON "budget_reservations" USING btree ("expires_at") WHERE released_at IS NULL;--> statement-breakpoint
ALTER TABLE "app_daily_usage" ADD CONSTRAINT "app_daily_usage_reserved_check" CHECK (reserved_usd >= 0);--> statement-breakpoint
ALTER TABLE "user_daily_usage" ADD CONSTRAINT "user_daily_usage_reserved_check" CHECK (reserved_usd >= 0);