CREATE TABLE "VisitorContact" ("id" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "name" TEXT NOT NULL, "mobile" TEXT NOT NULL, "source" TEXT NOT NULL, "consentText" TEXT NOT NULL, CONSTRAINT "VisitorContact_pkey" PRIMARY KEY ("id"));
CREATE INDEX "VisitorContact_mobile_idx" ON "VisitorContact"("mobile");
CREATE INDEX "VisitorContact_createdAt_idx" ON "VisitorContact"("createdAt");
