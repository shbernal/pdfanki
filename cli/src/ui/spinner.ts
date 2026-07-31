export interface SpinnerOptions {
  enabled: boolean
  stream?: NodeJS.WriteStream
  intervalMs?: number
}

const FRAMES = ['|', '/', '-', '\\']

function eraseLine(stream: NodeJS.WriteStream) {
  stream.write('\r\u001b[2K')
}

export interface Spinner {
  start: (text: string) => void
  update: (text: string) => void
  stop: () => void
}

export function createSpinner(options: SpinnerOptions): Spinner {
  const { enabled, stream = process.stdout, intervalMs = 80 } = options

  const interactive = enabled && stream.isTTY
  let activeText = ''
  let frameIndex = 0
  let timer: NodeJS.Timeout | null = null

  function draw() {
    const frame = FRAMES[frameIndex % FRAMES.length]
    frameIndex += 1
    eraseLine(stream)
    stream.write(`${frame} ${activeText}`)
  }

  function start(text: string) {
    if (!interactive) return
    activeText = text
    frameIndex = 0
    if (timer) clearInterval(timer)
    draw()
    timer = setInterval(draw, intervalMs)
  }

  function update(text: string) {
    if (!interactive) return
    activeText = text
    draw()
  }

  function stop() {
    if (!interactive) return
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    eraseLine(stream)
  }

  return {
    start,
    update,
    stop,
  }
}
