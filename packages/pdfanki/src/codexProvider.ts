import { spawn } from 'node:child_process'

export interface CodexCliRunnerResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface CodexCliRunnerOptions {
  command: string
  cwd?: string
  timeoutMs: number
}

export type CodexCliRunner = (
  args: string[],
  input: string,
  options: CodexCliRunnerOptions,
) => Promise<CodexCliRunnerResult>

export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high'] as const

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number]

export interface BuildCodexExecArgsOptions {
  model?: string
  reasoningEffort?: CodexReasoningEffort
  profile?: string
}

export type CodexProviderOptions = {
  prompt: string
  content: string
  command?: string
  cwd?: string
  timeoutMs?: number
  runner?: CodexCliRunner
} & BuildCodexExecArgsOptions

const DEFAULT_CODEX_COMMAND = 'codex'
const DEFAULT_CODEX_TIMEOUT_MS = 600_000
const MAX_ERROR_OUTPUT_LENGTH = 2_000
const CODEX_PROFILE_PATTERN = /^[A-Za-z0-9_-]+$/

export function buildCodexExecPrompt(options: {
  prompt: string
  content: string
}): string {
  return [
    'You are an experimental pdfanki flashcard-generation provider.',
    'Use only the prompt and source text below. Do not inspect files, run commands, or modify the workspace.',
    'Return only the requested Markdown flashcards with no extra commentary.',
    '',
    'Prompt:',
    options.prompt.trim(),
    '',
    'Source text:',
    options.content.trim(),
  ].join('\n')
}

export function buildCodexExecArgs(
  options?: string | BuildCodexExecArgsOptions,
): string[] {
  const normalizedOptions =
    typeof options === 'string' ? { model: options } : (options ?? {})
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--sandbox',
    'read-only',
  ]

  const normalizedProfile = normalizeCodexProfile(normalizedOptions.profile)
  if (normalizedProfile) {
    args.push('--profile', normalizedProfile)
  }

  const normalizedModel = normalizedOptions.model?.trim()
  if (normalizedModel) {
    args.push('--model', normalizedModel)
  }

  const reasoningEffort = normalizeCodexReasoningEffort(
    normalizedOptions.reasoningEffort,
  )
  if (reasoningEffort) {
    args.push('--config', `model_reasoning_effort="${reasoningEffort}"`)
  }

  args.push('-')
  return args
}

export async function callCodexProvider(
  options: CodexProviderOptions,
): Promise<string> {
  const command =
    options.command?.trim() ||
    process.env.PDFANKI_CODEX_COMMAND?.trim() ||
    DEFAULT_CODEX_COMMAND
  const timeoutMs = normalizeTimeoutMs(
    options.timeoutMs ?? Number(process.env.PDFANKI_CODEX_TIMEOUT_MS),
  )
  const runner = options.runner ?? runCodexCli
  const prompt = buildCodexExecPrompt({
    prompt: options.prompt,
    content: options.content,
  })
  const result = await runner(
    buildCodexExecArgs({
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      profile: options.profile,
    }),
    prompt,
    {
      command,
      cwd: options.cwd,
      timeoutMs,
    },
  )

  if (result.exitCode !== 0) {
    const detail = formatCodexErrorOutput(result.stderr || result.stdout)
    const status = result.signal
      ? `signal ${result.signal}`
      : `exit code ${result.exitCode ?? 'unknown'}`
    throw new Error(
      `Codex CLI provider failed with ${status}.${detail ? `\n${detail}` : ''}`,
    )
  }

  const output = result.stdout.trim()
  if (!output) {
    throw new Error('Codex CLI provider returned no stdout content.')
  }

  return output
}

export function runCodexCli(
  args: string[],
  input: string,
  options: CodexCliRunnerOptions,
): Promise<CodexCliRunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(
        new Error(
          `Codex CLI provider timed out after ${Math.round(options.timeoutMs / 1000)}s.`,
        ),
      )
    }, options.timeoutMs)
    timeout.unref?.()

    child.stdout.on('data', chunk => {
      stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', chunk => {
      stderr.push(Buffer.from(chunk))
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(
        new Error(
          `Unable to start Codex CLI provider command "${options.command}": ${error.message}`,
        ),
      )
    })
    child.on('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        signal,
      })
    })

    child.stdin.end(input)
  })
}

function normalizeTimeoutMs(value: number): number {
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  return DEFAULT_CODEX_TIMEOUT_MS
}

function normalizeCodexReasoningEffort(
  value?: CodexReasoningEffort,
): CodexReasoningEffort | undefined {
  if (!value) return undefined
  if (CODEX_REASONING_EFFORTS.includes(value)) return value
  throw new Error(
    `Invalid Codex reasoning effort "${String(value)}". Expected one of: ${CODEX_REASONING_EFFORTS.join(', ')}.`,
  )
}

function normalizeCodexProfile(value?: string): string | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (CODEX_PROFILE_PATTERN.test(normalized)) return normalized
  throw new Error(
    `Invalid Codex profile "${value}". Use letters, numbers, hyphens, or underscores.`,
  )
}

function formatCodexErrorOutput(value: string): string {
  const cleaned = redactSensitiveText(value).trim()
  if (!cleaned) return ''
  const truncated =
    cleaned.length > MAX_ERROR_OUTPUT_LENGTH
      ? `${cleaned.slice(0, MAX_ERROR_OUTPUT_LENGTH)}...`
      : cleaned
  return truncated
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_\-]{12,})\b/g, '[redacted-api-key]')
    .replace(/((?:CODEX|OPENAI)_API_KEY=)\S+/gi, '$1[redacted]')
}
