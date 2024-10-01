import { GolemNetwork } from '@golem-sdk/golem-js'
import { pinoPrettyLogger } from '@golem-sdk/pino-logger'
import { clearInterval } from 'node:timers'

/**
 * Utility function to wait for a certain condition to be met or abort when needed
 *
 * @param {Function} check The callback to use to verify if the condition is met
 * @param {AbortSignal} abortSignal The signal to observe and cancel waiting if raised
 *
 * @return {Promise<void>}
 */
const waitFor = async (check, abortSignal) => {
  let verifyInterval

  const verify = new Promise((resolve) => {
    verifyInterval = setInterval(async () => {
      if (abortSignal.aborted) {
        resolve()
      }

      if (await check()) {
        resolve()
      }
    }, 3 * 1000)
  })

  return verify.finally(() => {
    clearInterval(verifyInterval)
  })
}

/**
 * Helper function breaking stdout/sterr multiline strings into separate lines
 *
 * @param {String} multiLineStr
 *
 * @return {String[]} Separate and trimmed lines
 */
const splitMultiline = (multiLineStr) => {
  return multiLineStr
    .split('\n')
    .filter((line) => !!line)
    .map((line) => line.trim())
}

const myProposalFilter = (proposal) => {
  /*
// This filter can be used to engage a provider we used previously.
// It should have the image cached so the deployment will be faster.
 if (proposal.provider.name == "<enter provider name here>") return true;
 else return false;
*/
  return true
}

const glm = new GolemNetwork({
  logger: pinoPrettyLogger({
    level: 'info',
  }),
  api: { key: 'try_golem' },
  payment: {
    driver: 'erc20',
    network: 'polygon',
  },
})

const controller = new AbortController()

let rental = null
let isShuttingDown = 0
let serverOnProviderReady = false

try {
  // Establish a link with the Golem Network
  await glm.connect()

  // Prepare for user-initiated shutdown
  process.on('SIGINT', async function () {
    console.log(' Server shutdown was initiated by CTRL+C.')

    if (isShuttingDown > 1) {
      await new Promise((res) => setTimeout(res, 2 * 1000))
      return process.exit(1)
    }

    isShuttingDown++
    controller.abort('SIGINT received')

    await rental?.stopAndFinalize()
    await glm.disconnect()
  })


  const order = {
    demand: {
      workload: {
        imageHash: '79e703e4bddb19a68529eddc0d1dfde1aed0041659c8e9195b9e5205', // ollama with qwen2:0.5b
        minMemGib: 4,
        capabilities: ['!exp:gpu'],
        runtime: { name: 'vm-nvidia' },
      },
    },
    market: {
      rentHours: 0.5,
      pricing: {
        model: 'linear',
        maxStartPrice: 0.0,
        maxCpuPerHourPrice: 0.0,
        maxEnvPerHourPrice: 2.0,
      },
      offerProposalFilter: myProposalFilter,
    },
    network,
  }

  rental = await glm.oneOf({ order }, controller)
  const exe = await rental.getExeUnit(controller)

  const server = await exe.runAndStream(
    `./createXcrunch create3 -z 2 -c 0xb3a6595a49fa9d4808d05338274e3be36aef21b5` // new image should have HOME=/root
  )

  server.stdout.subscribe((data) => {
    // Debugging purpose
    splitMultiline(data).map((line) => console.log('provider >>', line))
  })

  server.stderr.subscribe((data) => {
    // Debugging purpose
    splitMultiline(data).map((line) => console.log('provider !!', line)) // Once we see that the server has started to listen, we can continue

    if (data.toString().includes('Listening on [::]:11434')) {
      serverOnProviderReady = true
    }
  }) // Wait for the server running on the provider to be fully started

  await waitFor(() => serverOnProviderReady, controller.signal) // Create a proxy instance for that server

  proxy = exe.createTcpProxy(PORT_ON_PROVIDER)

  proxy.events.on('error', (error) =>
    console.error('TcpProxy reported an error:', error)
  ) // Start listening and expose the port on your requestor machine

  await proxy.listen(PORT_ON_REQUESTOR)
  console.log(`Server Proxy listen at http://localhost:${PORT_ON_REQUESTOR}`) // Keep the process running to the point where the server exits or the execution is aborted

  await waitFor(() => server.isFinished(), controller.signal)
} catch (err) {
  console.error('Failed to run the example', err)
} finally {
  await glm.disconnect()
}