-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "deployer" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "salt" TEXT,
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);
