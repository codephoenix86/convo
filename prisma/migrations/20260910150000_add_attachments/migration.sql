CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "storage_key" VARCHAR(1024) NOT NULL,
    "mime_type" VARCHAR(255) NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attachments_size_check" CHECK ("size" > 0 AND "size" <= 10485760),
    CONSTRAINT "attachments_dimensions_check" CHECK (
        ("width" IS NULL AND "height" IS NULL)
        OR
        ("width" BETWEEN 1 AND 20000 AND "height" BETWEEN 1 AND 20000)
    )
);

CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");
CREATE INDEX "attachments_message_id_idx" ON "attachments"("message_id");

ALTER TABLE "attachments"
ADD CONSTRAINT "attachments_message_id_fkey"
FOREIGN KEY ("message_id") REFERENCES "messages"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
