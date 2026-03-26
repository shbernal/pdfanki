import { promises as fs } from 'fs'
import { join } from 'path'
import { ensureConfig, sanitizePromptName } from './config.js'

const GITHUB_PROMPTS_CONTENTS_API_URL =
  'https://api.github.com/repos/shbernal/pdfanki/contents/cli/prompts?ref=master'
const GITHUB_ACCEPT_HEADER = 'application/vnd.github+json'
const GITHUB_USER_AGENT = '@shbernal/pdfanki-cli'

type RemotePromptDirectoryEntry = {
  name?: unknown
  type?: unknown
  download_url?: unknown
}

export type PromptSummary = {
  name: string
  path: string
}

export type RemotePromptSummary = {
  name: string
  downloadUrl: string
}

type InstallRemotePromptOptions = {
  force?: boolean
}

type InstallRemotePromptResult = {
  name: string
  path: string
  overwritten: boolean
}

function isMarkdownPromptEntry(entry: RemotePromptDirectoryEntry): entry is {
  name: string
  type: 'file'
  download_url: string
} {
  return (
    entry.type === 'file' &&
    typeof entry.name === 'string' &&
    /\.md$/i.test(entry.name) &&
    typeof entry.download_url === 'string' &&
    entry.download_url.length > 0
  )
}

function buildGitHubHeaders(): Record<string, string> {
  return {
    Accept: GITHUB_ACCEPT_HEADER,
    'User-Agent': GITHUB_USER_AGENT,
  }
}

function buildGitHubApiErrorMessage(
  response: Response,
  details: string,
): string {
  const base = `Failed to fetch remote prompts from GitHub (${response.status} ${response.statusText}).`
  const remaining = response.headers.get('x-ratelimit-remaining')
  if (response.status === 403 && remaining === '0') {
    const reset = response.headers.get('x-ratelimit-reset')
    if (reset) {
      const resetAt = new Date(Number(reset) * 1000)
      if (!Number.isNaN(resetAt.getTime())) {
        return `${base} GitHub API rate limit reached. Reset at ${resetAt.toISOString()}.`
      }
    }

    return `${base} GitHub API rate limit reached.`
  }

  if (details.length > 0) {
    return `${base} ${details.slice(0, 200)}`
  }

  return base
}

async function fetchRemotePromptDirectory(): Promise<RemotePromptSummary[]> {
  const response = await fetch(GITHUB_PROMPTS_CONTENTS_API_URL, {
    headers: buildGitHubHeaders(),
  })

  if (!response.ok) {
    const details = (await response.text()).trim()
    throw new Error(buildGitHubApiErrorMessage(response, details))
  }

  const payload = (await response.json()) as unknown
  if (!Array.isArray(payload)) {
    throw new Error(
      'Failed to fetch remote prompts from GitHub: unexpected API response shape.',
    )
  }

  return payload
    .map(entry => entry as RemotePromptDirectoryEntry)
    .filter(entry => entry.type === 'file' && typeof entry.name === 'string')
    .filter(entry => /\.md$/i.test(entry.name as string))
    .map(entry => {
      if (!isMarkdownPromptEntry(entry)) {
        throw new Error(
          'Failed to fetch remote prompts from GitHub: markdown prompt entry missing download_url.',
        )
      }

      return {
        name: entry.name.replace(/\.md$/i, ''),
        downloadUrl: entry.download_url,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

async function fetchRemotePromptContents(
  name: string,
  downloadUrl: string,
): Promise<string> {
  const response = await fetch(downloadUrl, {
    headers: {
      'User-Agent': GITHUB_USER_AGENT,
    },
  })

  if (!response.ok) {
    const details = (await response.text()).trim()
    const suffix = details.length > 0 ? ` ${details.slice(0, 200)}` : ''
    throw new Error(
      `Failed to download remote prompt "${name}" (${response.status} ${response.statusText}).${suffix}`,
    )
  }

  return response.text()
}

async function checkPromptExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

export async function listLocalPrompts(): Promise<PromptSummary[]> {
  const paths = await ensureConfig()
  const entries = await fs.readdir(paths.promptsDir, { withFileTypes: true })

  return entries
    .filter(entry => entry.isFile() && /\.md$/i.test(entry.name))
    .map(entry => ({
      name: entry.name.replace(/\.md$/i, ''),
      path: join(paths.promptsDir, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export async function listRemotePrompts(): Promise<RemotePromptSummary[]> {
  return fetchRemotePromptDirectory()
}

export async function installRemotePrompt(
  rawName: string,
  options: InstallRemotePromptOptions = {},
): Promise<InstallRemotePromptResult> {
  const name = sanitizePromptName(rawName)
  const remotePrompts = await fetchRemotePromptDirectory()
  const remotePrompt = remotePrompts.find(prompt => prompt.name === name)

  if (!remotePrompt) {
    throw new Error(
      `Remote prompt "${name}" not found in the pdfanki prompt catalog.`,
    )
  }

  const paths = await ensureConfig()
  const promptPath = join(paths.promptsDir, `${name}.md`)
  const promptExists = await checkPromptExists(promptPath)

  if (promptExists && !options.force) {
    throw new Error(
      `Prompt "${name}" already exists at ${promptPath}. Use --force to overwrite it.`,
    )
  }

  const contents = await fetchRemotePromptContents(
    name,
    remotePrompt.downloadUrl,
  )
  await fs.writeFile(promptPath, contents, 'utf8')

  return {
    name,
    path: promptPath,
    overwritten: promptExists,
  }
}
