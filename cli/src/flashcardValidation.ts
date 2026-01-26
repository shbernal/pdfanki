export type Flashcard = {
  front: string
  bullets: string[]
}

export function parseFlashcardMarkdown(markdown: string): Flashcard[] {
  const lines = markdown.trim().split(/\r?\n/)
  const cards: Flashcard[] = []
  const errors: string[] = []

  let current: Flashcard | null = null

  const flushCurrent = () => {
    if (!current) return
    if (!current.front) {
      errors.push('Card is missing a front title after "## "')
    }
    if (current.bullets.length === 0) {
      errors.push(`Card "${current.front}" is missing bullet items`)
    }
    cards.push(current)
    current = null
  }

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()

    // Blank line closes the current card (if any) and is otherwise ignored.
    if (trimmed === '') {
      if (current) flushCurrent()
      return
    }

    if (line.startsWith('## ')) {
      if (current) flushCurrent()
      const front = line.slice(3).trim()
      if (!front) {
        errors.push(`Line ${idx + 1}: empty card front after "## "`)
      }
      current = { front, bullets: [] }
      return
    }

    if (line.startsWith('- ')) {
      if (!current) {
        errors.push(`Line ${idx + 1}: bullet item found before any card front`)
        return
      }
      const bullet = line.slice(2).trim()
      if (!bullet) {
        errors.push(`Line ${idx + 1}: empty bullet item`)
        return
      }
      current.bullets.push(bullet)
      return
    }

    // Ignore non-bullet, non-heading content between cards (e.g., separators).
  })

  if (current) flushCurrent()

  if (cards.length === 0) {
    errors.push('No flashcards detected (expected lines starting with "## ")')
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '))
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
