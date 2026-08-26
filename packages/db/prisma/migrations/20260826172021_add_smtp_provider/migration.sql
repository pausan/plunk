-- CreateEnum
CREATE TYPE "SendingProviderType" AS ENUM ('SES', 'SMTP');

-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "sendingProvider" "SendingProviderType";

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "sendingProvider" "SendingProviderType" NOT NULL DEFAULT 'SES',
ADD COLUMN     "sendingProviderMisconfigured" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "smtp_configs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT true,
    "username" TEXT NOT NULL,
    "fromOverride" TEXT,
    "encryptedPassword" TEXT NOT NULL,
    "passwordIv" TEXT NOT NULL,
    "passwordAuthTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "maxSendRatePerSecond" INTEGER NOT NULL DEFAULT 5,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smtp_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "smtp_configs_projectId_key" ON "smtp_configs"("projectId");

-- AddForeignKey
ALTER TABLE "smtp_configs" ADD CONSTRAINT "smtp_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
