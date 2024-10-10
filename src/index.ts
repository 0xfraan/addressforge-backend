import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { JobManager, Job } from "@golem-sdk/golem-js/experimental"
import { PrismaClient } from '@prisma/client'
import { MarketOrderSpec } from '@golem-sdk/golem-js'

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

  async createParallelJobs(jobRequest: JobRequest): Promise<string> {
    const { owner, pattern, deployer } = jobRequest
    console.log(`Creating parallel jobs for owner: ${owner}, pattern: ${pattern}, deployer: ${deployer}`)

    const cpu: MarketOrderSpec = {
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
        },
      }

    const jobId = `job-${Date.now()}`
    console.log(`Generated job ID: ${jobId}`)

    const jobs: Job[] = []

    // Create a job in the database
    await prisma.job.create({
      data: {
        id: jobId,
        owner,
        pattern,
        deployer,
        state: "running",
      },
    })
    console.log(`Created job in database with ID: ${jobId}`)

    const resultPromise = new Promise<{ salt: string; address: string }>((resolve, reject) => {
      for (let i = 0; i < 3; i++) {
        const job = this.jobManager.createJob(cpu)
        jobs.push(job)
        console.log(`Created Golem job ${i + 1} with ID: ${job.id}`)

        job.startWork(async (exe) => {
          console.log(`Job ${job.id} started execution`)
          try {
            const result = await exe.run(`./createXcrunch create3 -m ${pattern} -c ${deployer}`)
            console.log(`Job ${job.id} completed execution`)
            const r = result.stdout as string
            console.log(`Job ${job.id} output: ${r}`)
            const [salt, address] = r.split(",")
            console.log(`Job ${job.id} resolved with salt: ${salt}, address: ${address.trim()}`)
            resolve({ salt, address: address.trim() })
          } catch (error) {
            console.error(`Error in job ${job.id} execution:`, error)
            // if (jobs.every(j => j.state === "error")) {
            //   console.error("All jobs failed")
            //   reject(new Error("All jobs failed"))
            // }
          }
        })

        job.events.on("error", (error) => {
          console.error(`Job ${job.id} failed:`, error)
        //   if (jobs.every(j => j.state === "error")) {
        //     console.error("All jobs failed")
        //     reject(new Error("All jobs failed"))
        //   }
        })
      }
    })

    try {
      const { salt, address } = await resultPromise
      console.log(`Job ${jobId} completed successfully with salt: ${salt}, address: ${address}`)

      // Terminate all jobs
      jobs.forEach(job => {
        console.log(`Terminating job ${job.id}`)
        job.cancel()
      })

      // Update the job in the database
      await prisma.job.update({
        where: { id: jobId },
        data: {
          state: "done",
          salt,
          address,
          finishedAt: new Date(),
        },
      })
      console.log(`Updated job ${jobId} in database as completed`)

      return jobId
    } catch (error) {
      console.error(`Error in parallel jobs for job ${jobId}:`, error)
      
      // Update the job status to failed
      await prisma.job.update({
        where: { id: jobId },
        data: {
          state: "failed",
          finishedAt: new Date(),
        },
      })
      console.log(`Updated job ${jobId} in database as failed`)

      throw error
    }
  }
}

const jobManagerService = new JobManagerService()

const app = new Elysia()
  .use(cors())
  .post("/job", async ({ body, set }) => {
    console.log("Received POST request to /job")
    const { owner, pattern, deployer } = body as JobRequest

    if (!owner || !pattern || !deployer) {
      console.log("Missing required parameters in job request")
      set.status = 400
      return { error: "Missing required parameters" }
    }

    try {
      const jobId = jobManagerService.createParallelJobs({ owner, pattern, deployer })
      console.log(`Successfully created job with ID: ${jobId}`)
      return { id: jobId }
    } catch (error) {
      console.error("Error creating job:", error)
      set.status = 500
      return { error: "Error creating job" }
    }
  })
  .get("/job/:id", async ({ params: { id }, set }) => {
    console.log(`Received GET request for job ${id}`)
    try {
      const job = await prisma.job.findUnique({
        where: { id },
      })
      if (!job) {
        console.log(`Job ${id} not found`)
        set.status = 404
        return { error: "Job not found" }
      }
      console.log(`Successfully retrieved job ${id}`)
      return job
    } catch (error) {
      console.error(`Error fetching job ${id}:`, error)
      set.status = 500
      return { error: "Error fetching job" }
    }
  })
  .get("/jobs/:ownerAddress", async ({ params: { ownerAddress }, set }) => {
    console.log(`Received GET request for jobs of owner ${ownerAddress}`)
    try {
      const jobs = await prisma.job.findMany({
        where: { owner: ownerAddress },
      })
      console.log(`Successfully retrieved ${jobs.length} jobs for owner ${ownerAddress}`)
      return jobs
    } catch (error) {
      console.error(`Error fetching jobs for owner ${ownerAddress}:`, error)
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