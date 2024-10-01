import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { JobManager, ReputationSystem } from "@golem-sdk/golem-js/experimental"
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

interface JobRequest {
  owner: string
  pattern: string
  deployer: string
}

class JobManagerService {
  private jobManager: JobManager

  constructor() {
    this.jobManager = new JobManager({
      yagna: { apiKey: process.env.YAGNA_API_KEY },
    })
  }

  async init() {
    try {
      await this.jobManager.init()
      console.log("Connected to the Golem Network!")
    } catch (error) {
      console.error("Failed to connect to the Golem Network:", error)
      process.exit(1)
    }
  }

  async close() {
    await this.jobManager.close()
  }

  async createJob(jobRequest: JobRequest) {
    const { owner, pattern, deployer } = jobRequest
    const reputation = await ReputationSystem.create({
      paymentNetwork: "polygon",
    });

    const job = this.jobManager.createJob({
      demand: {
        workload: {
          imageHash: "01e6bdd087a22f7b9f4c824f54b5599a0db6847dc2cb9a3f3055eef8",
        },
      },
      market: {
        rentHours: 0.5,
        pricing: {
          model: "linear",
          maxStartPrice: 0.5,
          maxCpuPerHourPrice: 1.0,
          maxEnvPerHourPrice: 0.5,
        },
        offerProposalFilter: reputation.offerProposalFilter(),
        offerProposalSelector: reputation.offerProposalSelector(),
      },
    })

    this.setupJobEventListeners(job)

    job.startWork(async (exe) => {
      try {
        const result = await exe.run(`./createXcrunch create3 -m ${pattern} -c ${deployer}`)
        const r = result.stdout as string
        try {
          const [salt, address] = r.split(",")
          await this.updateJobResult(job.id, salt, address.trim())
        } catch (error) {
          console.error("Error parsing job result:", error)
          console.log(r)
          await this.updateJobState(job.id, "failed")
        }
      } catch (error) {
        console.error("Error in job execution:", error)
        await this.updateJobState(job.id, "failed")
      }
    })

    return job
  }

  private setupJobEventListeners(job) {
    job.events.on("started", () => this.updateJobState(job.id, "running"))
    job.events.on("error", (error) => {
      console.error("Job failed", error)
      this.updateJobState(job.id, "failed")
    })
    job.events.on("success", () => this.updateJobState(job.id, "succeeded"))
  }

  private async updateJobState(jobId: string, state: string) {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: { state },
      })
    } catch (error) {
      console.error("Error updating job state:", error)
    }
  }

  private async updateJobResult(jobId: string, salt: string, address: string) {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          state: "done",
          salt,
          address,
          finishedAt: new Date(),
        },
      })
    } catch (error) {
      console.error("Error updating job result:", error)
    }
  }
}

const jobManagerService = new JobManagerService()

const app = new Elysia()
  .use(cors())
  .post("/job", async ({ body, set }) => {
    const { owner, pattern, deployer } = body as JobRequest

    if (!owner || !pattern || !deployer) {
      set.status = 400
      return { error: "Missing required parameters" }
    }

    try {
      const job = jobManagerService.createJob({ owner, pattern, deployer })
      const savedJob = await prisma.job.create({
        data: {
          id: job.id,
          owner,
          pattern,
          deployer,
          state: "created",
        },
      })
      return { id: savedJob.id }
    } catch (error) {
      console.error("Error creating job:", error)
      set.status = 500
      return { error: "Error creating job" }
    }
  })
  .get("/job/:id", async ({ params: { id }, set }) => {
    try {
      const job = await prisma.job.findUnique({
        where: { id },
      })
      if (!job) {
        set.status = 404
        return { error: "Job not found" }
      }
      return job
    } catch (error) {
      console.error("Error fetching job:", error)
      set.status = 500
      return { error: "Error fetching job" }
    }
  })
  .get("/jobs/:ownerAddress", async ({ params: { ownerAddress }, set }) => {
    try {
      const jobs = await prisma.job.findMany({
        where: { owner: ownerAddress },
      })
      return jobs
    } catch (error) {
      console.error("Error fetching jobs:", error)
      set.status = 500
      return { error: "Error fetching jobs" }
    }
  })
  .listen(3333)

console.log(`Server is running on http://localhost:${app.server?.port}`)

process.on("SIGINT", async () => {
  console.log("Gracefully shutting down...")
  await jobManagerService.close()
  await prisma.$disconnect()
  app.stop()
  process.exit(0)
})

// Initialize the job manager
jobManagerService.init().catch((error) => {
  console.error("Failed to initialize job manager:", error)
  process.exit(1)
})