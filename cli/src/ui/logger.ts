export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type ColorName = 'dim' | 'cyan' | 'green' | 'yellow' | 'red' | 'gray' | 'reset'

const ANSI: Record<ColorName, string> = {
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  gray: '\u001b[90m',
  reset: '\u001b[0m',
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export type LoggerOptions = {
  level: LogLevel
  useColor: boolean
  stdout?: NodeJS.WriteStream
  stderr?: NodeJS.WriteStream
}

function paint(text: string, color: ColorName, enabled: boolean): string {
  if (!enabled || color === 'reset') return text
  return `${ANSI[color]}${text}${ANSI.reset}`
}

export type Logger = {
  isDebugEnabled: boolean
  debug: (message: string) => void
  info: (message: string) => void
  success: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

export function createLogger(options: LoggerOptions): Logger {
  const {
    level,
    useColor,
    stdout = process.stdout,
    stderr = process.stderr,
  } = options

  const currentWeight = LEVEL_WEIGHT[level]

  function shouldLog(target: LogLevel): boolean {
    return LEVEL_WEIGHT[target] >= currentWeight
  }

  function write(
    stream: NodeJS.WriteStream,
    targetLevel: LogLevel,
    prefix: string,
    message: string,
    color: ColorName,
  ) {
    if (!shouldLog(targetLevel)) return
    const formattedPrefix = paint(prefix, color, useColor)
    stream.write(`${formattedPrefix} ${message}\n`)
  }

  return {
    isDebugEnabled: shouldLog('debug'),
    debug(message: string) {
      write(stdout, 'debug', '[dbg]', message, 'gray')
    },
    info(message: string) {
      write(stdout, 'info', '[i]', message, 'cyan')
    },
    success(message: string) {
      write(stdout, 'info', '[ok]', message, 'green')
    },
    warn(message: string) {
      write(stderr, 'warn', '[warn]', message, 'yellow')
    },
    error(message: string) {
      write(stderr, 'error', '[err]', message, 'red')
    },
  }
}
