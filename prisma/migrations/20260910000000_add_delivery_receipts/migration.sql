-- AlterTable
ALTER TABLE "conversation_members"
ADD COLUMN "last_delivered_message_id" UUID,
ADD COLUMN "last_delivered_at" TIMESTAMPTZ(3);

-- Existing read positions necessarily represent delivery as well.
UPDATE "conversation_members"
SET
    "last_delivered_message_id" = "last_read_message_id",
    "last_delivered_at" = "last_read_at"
WHERE "last_read_message_id" IS NOT NULL;

-- Keep the durable delivery cursor internally consistent.
ALTER TABLE "conversation_members"
ADD CONSTRAINT "conversation_members_delivery_state_check" CHECK (
    ("last_delivered_message_id" IS NULL AND "last_delivered_at" IS NULL)
    OR
    ("last_delivered_message_id" IS NOT NULL AND "last_delivered_at" IS NOT NULL)
),
ADD CONSTRAINT "conversation_members_read_implies_delivery_check" CHECK (
    "last_read_at" IS NULL
    OR "last_delivered_at" > "last_read_at"
    OR (
        "last_delivered_at" = "last_read_at"
        AND "last_delivered_message_id" >= "last_read_message_id"
    )
);

-- CreateIndex
CREATE INDEX "conversation_members_last_delivered_message_idx"
ON "conversation_members"("conversation_id", "last_delivered_message_id");

-- AddForeignKey
ALTER TABLE "conversation_members"
ADD CONSTRAINT "conversation_members_conversation_id_last_delivered_message_id_fkey"
FOREIGN KEY ("conversation_id", "last_delivered_message_id")
REFERENCES "messages"("conversation_id", "id")
ON DELETE NO ACTION ON UPDATE CASCADE;
