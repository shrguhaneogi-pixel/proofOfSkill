CREATE TABLE "challenges" (
	"id" smallint PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"difficulty" text NOT NULL,
	"category" text NOT NULL,
	"estimated_minutes" integer NOT NULL,
	"prompt" text NOT NULL,
	"credential_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenges_id_in_program_range" CHECK ("challenges"."id" >= 1 AND "challenges"."id" <= 5),
	CONSTRAINT "challenges_difficulty_allowed" CHECK ("challenges"."difficulty" IN ('beginner', 'intermediate', 'advanced')),
	CONSTRAINT "challenges_category_allowed" CHECK ("challenges"."category" IN ('Solana', 'Anchor', 'Web3 Frontend', 'Security')),
	CONSTRAINT "challenges_estimated_minutes_positive" CHECK ("challenges"."estimated_minutes" > 0),
	CONSTRAINT "challenges_slug_not_blank" CHECK (char_length(btrim("challenges"."slug")) > 0),
	CONSTRAINT "challenges_slug_is_kebab_case" CHECK ("challenges"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "challenges_title_not_blank" CHECK (char_length(btrim("challenges"."title")) > 0),
	CONSTRAINT "challenges_description_not_blank" CHECK (char_length(btrim("challenges"."description")) > 0),
	CONSTRAINT "challenges_prompt_not_blank" CHECK (char_length(btrim("challenges"."prompt")) > 0),
	CONSTRAINT "challenges_credential_type_not_blank" CHECK (char_length(btrim("challenges"."credential_type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "rubric_criteria" (
	"challenge_id" smallint NOT NULL,
	"id" text NOT NULL,
	"label" text NOT NULL,
	"weight" integer NOT NULL,
	"ordinal" smallint NOT NULL,
	CONSTRAINT "rubric_criteria_challenge_id_id_pk" PRIMARY KEY("challenge_id","id"),
	CONSTRAINT "rubric_criteria_weight_positive" CHECK ("rubric_criteria"."weight" > 0),
	CONSTRAINT "rubric_criteria_weight_within_total" CHECK ("rubric_criteria"."weight" <= 100),
	CONSTRAINT "rubric_criteria_ordinal_non_negative" CHECK ("rubric_criteria"."ordinal" >= 0),
	CONSTRAINT "rubric_criteria_id_not_blank" CHECK (char_length(btrim("rubric_criteria"."id")) > 0),
	CONSTRAINT "rubric_criteria_id_is_snake_case" CHECK ("rubric_criteria"."id" ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "rubric_criteria_label_not_blank" CHECK (char_length(btrim("rubric_criteria"."label")) > 0)
);
--> statement-breakpoint
ALTER TABLE "rubric_criteria" ADD CONSTRAINT "rubric_criteria_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "challenges_slug_unique" ON "challenges" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "rubric_criteria_position_unique" ON "rubric_criteria" USING btree ("challenge_id","ordinal");