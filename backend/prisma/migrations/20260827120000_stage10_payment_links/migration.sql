-- Stage 10: one real payment link per case (D-123).
CREATE TABLE "payment_links" (
    "id" TEXT NOT NULL,
    "caseId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "shortUrl" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_links_caseId_key" ON "payment_links"("caseId");

ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
