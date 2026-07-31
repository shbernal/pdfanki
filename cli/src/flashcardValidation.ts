export interface Flashcard {
  front: string
  bullets: string[]
}

interface ValidationIssue {
  message: string
  lines: number[]
}

function formatLineRanges(lineNumbers: number[]): string {
  const normalized = Array.from(
    new Set(
      lineNumbers
        .filter(line => Number.isInteger(line) && line > 0)
        .sort((a, b) => a - b),
    ),
  )

  if (normalized.length === 0) {
    return 'unknown'
  }

  const ranges: string[] = []
  let rangeStart = normalized[0]
  let previous = normalized[0]

  for (let i = 1; i < normalized.length; i++) {
    const current = normalized[i]
    if (current === previous + 1) {
      previous = current
      continue
    }

    ranges.push(
      rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`,
    )
    rangeStart = current
    previous = current
  }

  ranges.push(
    rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`,
  )
  return ranges.join(', ')
}

function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues
    .map((issue, index) => {
      const lineLabel = `lines ${formatLineRanges(issue.lines)}`
      return `${index + 1}. ${issue.message}\n   ${lineLabel}`
    })
    .join('\n')
}

export function parseFlashcardMarkdown(markdown: string): Flashcard[] {
  const lines = markdown.trim().split(/\r?\n/)
  const cards: Flashcard[] = []
  const issues: ValidationIssue[] = []

  type WorkingCard = Flashcard & {
    startLine: number
    endLine: number
  }

  let current: WorkingCard | null = null

  const addIssue = (message: string, lineNumbers: number[] = []) => {
    issues.push({
      message,
      lines: lineNumbers,
    })
  }

  const flushCurrent = (endLine: number) => {
    if (!current) return
    if (current.bullets.length === 0) {
      const spanStart = current.startLine
      const spanEnd = Math.max(current.endLine, endLine, spanStart)
      const cardLineNumbers: number[] = []
      for (let line = spanStart; line <= spanEnd; line++) {
        cardLineNumbers.push(line)
      }
      addIssue(
        `Card "${current.front || '(empty front)'}" is missing bullet items`,
        cardLineNumbers,
      )
    }
    cards.push({
      front: current.front,
      bullets: current.bullets,
    })
    current = null
  }

  lines.forEach((rawLine, idx) => {
    const lineNumber = idx + 1
    const line = rawLine.trimEnd()
    const trimmed = line.trim()

    // Blank lines before the first bullet are allowed; after bullets start,
    // a blank line closes the current card.
    if (trimmed === '') {
      if (current?.bullets.length) {
        flushCurrent(lineNumber)
      } else if (current) {
        current.endLine = lineNumber
      }
      return
    }

    // `line` is right-trimmed, so a marker with nothing after it arrives here
    // as a bare "##" / "-" and must still be recognized as a marker.
    if (line.startsWith('## ') || line === '##') {
      if (current) flushCurrent(lineNumber - 1)
      const front = line.slice(3).trim()
      if (!front) {
        addIssue('Empty card front after "## "', [lineNumber])
      }
      current = {
        front,
        bullets: [],
        startLine: lineNumber,
        endLine: lineNumber,
      }
      return
    }

    if (line.startsWith('- ') || line === '-') {
      if (!current) {
        addIssue('Bullet item found before any card front', [lineNumber])
        return
      }
      const bullet = line.slice(2).trim()
      if (!bullet) {
        addIssue('Empty bullet item', [lineNumber])
        current.endLine = lineNumber
        return
      }
      current.bullets.push(bullet)
      current.endLine = lineNumber
      return
    }

    // Ignore non-bullet, non-heading content between cards (e.g., separators).
    if (current) {
      current.endLine = lineNumber
    }
  })

  if (current) flushCurrent(lines.length)

  if (cards.length === 0) {
    const nonEmptyLines = lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(entry => entry.line.trim().length > 0)
      .map(entry => entry.number)
    addIssue(
      'No flashcards detected (expected lines starting with "## ")',
      nonEmptyLines,
    )
  }

  if (issues.length > 0) {
    throw new Error(
      `Markdown validation failed:\n${formatValidationIssues(issues)}`,
    )
  }

  return cards
}

export function renderFlashcards(cards: Flashcard[]): string {
  return cards
    .map(card => {
      const body = card.bullets.map(bullet => `- ${bullet}`).join('\n')
      return [`## ${card.front}`, body].join('\n')
    })
    .join('\n\n')
    .trim()
}
