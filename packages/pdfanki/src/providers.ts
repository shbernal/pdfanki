import type { BookJson } from './types/flashcards.js'

export type SupportedProvider = 'gemini' | 'anthropic' | 'openai' | 'deepseek'

export type GenerateFlashcardsOptions = {
  provider: SupportedProvider
  model: string
  apiKey: string
  prompt: string
  content: string
}

const GEMINI_TIMEOUT_MS = 180_000
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'

export function bookJsonToPlainText(book: BookJson): string {
  const parts: string[] = []

  for (const section of book.content) {
    const sectionHeader = section.title
      ? `${section.index}. ${section.title}`
      : `Section ${section.index}`
    parts.push([sectionHeader, section.text ?? ''].filter(Boolean).join('\n'))
  }

  return parts.join('\n\n').trim()
}

export async function generateFlashcards(
  options: GenerateFlashcardsOptions,
): Promise<string> {
  const { provider } = options
  if (!options.apiKey) {
    throw new Error(`Missing API key for provider "${provider}".`)
  }

  switch (provider) {
    case 'gemini':
      return callGemini(options)
    case 'anthropic':
      return callAnthropic(options)
    case 'openai':
      return callOpenAI(options)
    case 'deepseek':
      return callDeepSeek(options)
    default:
      throw new Error(`Unsupported provider "${provider}".`)
  }
}

async function callGemini(options: GenerateFlashcardsOptions): Promise<string> {
  const { prompt, content, apiKey, model } = options
  try {
    const { GoogleGenAI } = await import('@google/genai')
    const client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: GEMINI_TIMEOUT_MS },
    })
    const response = await client.models.generateContent({
      model,
      contents: `${prompt}\n\n${content}`,
    })
    const text = response.text
    if (!text || typeof text !== 'string') {
      throw new Error('Gemini returned no text content.')
    }
    return text.trim()
  } catch (error) {
    if (isTimeoutError(error)) {
      throw Object.assign(
        new Error(
          `Gemini request timed out after ${Math.round(GEMINI_TIMEOUT_MS / 1000)}s.`,
        ),
        { cause: error as Error },
      )
    }

    throw Object.assign(
      new Error(`Gemini request failed: ${(error as Error).message}`),
      { cause: error as Error },
    )
  }
}

async function callAnthropic(
  options: GenerateFlashcardsOptions,
): Promise<string> {
  const { prompt, content, apiKey, model } = options
  const { Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `${prompt}\n\n${content}`,
      },
    ],
  })

  const firstTextBlock = response.content.find(
    block => block.type === 'text',
  ) as { type: string; text?: string } | undefined

  if (!firstTextBlock?.text) {
    throw new Error('Anthropic returned no text content.')
  }

  return firstTextBlock.text.trim()
}

async function callOpenAI(options: GenerateFlashcardsOptions): Promise<string> {
  return callOpenAICompatible({
    ...options,
    providerName: 'OpenAI',
  })
}

async function callDeepSeek(
  options: GenerateFlashcardsOptions,
): Promise<string> {
  return callOpenAICompatible({
    ...options,
    providerName: 'DeepSeek',
    baseURL: process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL,
  })
}

type OpenAICompatibleOptions = GenerateFlashcardsOptions & {
  providerName: string
  baseURL?: string
}

async function callOpenAICompatible(
  options: OpenAICompatibleOptions,
): Promise<string> {
  const { prompt, content, apiKey, model } = options
  const { providerName, baseURL } = options
  const OpenAI = (await import('openai')).default
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  })
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content },
    ],
    temperature: 0.3,
  })

  const text = response.choices?.[0]?.message?.content
  if (!text) {
    throw new Error(`${providerName} returned no text content.`)
  }

  return text.trim()
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { message?: string; name?: string; cause?: unknown }

  const message = err.message?.toLowerCase()
  if (err.name === 'AbortError') return true
  if (message && message.includes('timeout')) return true

  const cause = err.cause as
    | { message?: string; code?: unknown; name?: string }
    | undefined
  const causeMessage = cause?.message?.toLowerCase()
  if (cause?.name === 'AbortError') return true
  if (causeMessage && causeMessage.includes('timeout')) return true
  if (cause?.code && String(cause.code).toLowerCase().includes('timeout')) {
    return true
  }

  return false
}
