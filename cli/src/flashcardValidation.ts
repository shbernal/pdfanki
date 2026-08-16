/*
 * The producer half of Flashcard Markdown (https://github.com/shbernal/flashcard-md-spec).
 *
 * pdfanki conforms as a **producer**: it MUST emit canonical form only, and it SHOULD
 * fail loudly rather than emit something that is merely valid. That is why everything
 * here throws — the input is an LLM's output for one section, and a failure means
 * "ask again", not "give the user a broken deck".
 *
 * What it must NOT do is drop what it does not understand. The scanner this replaces
 * ignored anything that was neither `## ` nor `- `, which silently deleted nested list
 * items and every `###` heading from decks it had just generated. Both are ordinary card
 * body content, and the card body is arbitrary Markdown (§5.4). So the body is now kept
 * verbatim, and the checks below are policy over pdfanki's own output rather than claims
 * about the grammar.
 */

export interface Flashcard {
  front: string
  /**
   * The card body, verbatim, with leading and trailing blank lines trimmed. Kept as
   * source rather than as a bullet list because §5.4 makes it arbitrary Markdown, and
   * because a verbatim body is what lets the serializer reproduce a deck byte for byte.
   */
  body: string
}

interface ValidationIssue {
  message: string
  lines: number[]
}

/* `#` must be followed by a space or end the line; `#tag` is a paragraph in CommonMark. */
const HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const CLOSING_SEQUENCE = /[ \t]+#+$/
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const TOP_LEVEL_BULLET = /^[-*+][ \t]+\S/
const EMPTY_BULLET = /^[-*+][ \t]*$/
const SEPARATOR = '***'

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

interface ScannedLine {
  text: string
  number: number
  /** Inside a fenced code block, delimiters included. */
  inCode: boolean
  heading: { depth: number; text: string } | null
}

/**
 * A line scan that knows what is code.
 *
 * §5.3 requires it: a `***` inside a fence is content, and a parser matching on raw text
 * without tracking fence state splits a card in the middle of a code block. The same
 * state keeps a `## ` inside a fence from opening a card.
 */
function scan(markdown: string): ScannedLine[] {
  let fence: { marker: string; length: number } | null = null

  return markdown.split(/\r?\n/).map((raw, index) => {
    const text = raw.trimEnd()
    const number = index + 1
    const fenceMatch = FENCE.exec(text)

    if (fence) {
      const closes =
        fenceMatch !== null &&
        fenceMatch[1].startsWith(fence.marker) &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim() === ''

      if (closes) fence = null

      return { text, number, inCode: true, heading: null }
    }

    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length }
      return { text, number, inCode: true, heading: null }
    }

    const headingMatch = HEADING.exec(text)
    if (headingMatch) {
      return {
        text,
        number,
        inCode: false,
        heading: {
          depth: headingMatch[1].length,
          text: (headingMatch[2] ?? '').replace(CLOSING_SEQUENCE, '').trim(),
        },
      }
    }

    return { text, number, inCode: false, heading: null }
  })
}

const trimBlankEnds = (lines: ScannedLine[]): ScannedLine[] => {
  let start = 0
  let end = lines.length

  while (start < end && !lines[start].text.trim()) start += 1
  while (end > start && !lines[end - 1].text.trim()) end -= 1

  return lines.slice(start, end)
}

export function parseFlashcardMarkdown(markdown: string): Flashcard[] {
  const lines = scan(markdown)
  const cards: Flashcard[] = []
  const issues: ValidationIssue[] = []
  const seenFronts = new Map<string, number>()

  const addIssue = (message: string, lineNumbers: number[] = []) => {
    issues.push({ message, lines: lineNumbers })
  }

  let open: { front: string; line: number; body: ScannedLine[] } | null = null

  const close = () => {
    if (!open) return

    const card = open
    open = null

    const body = trimBlankEnds(card.body)
    const bodyLines = body.map(line => line.number)
    const label = card.front || '(empty front)'

    /* §5.5 makes a bullet-less card *valid*, and a consumer must accept one. Refusing to
       emit one is a different thing: this is pdfanki policy over its own model's output,
       where an answer with nothing in it means the model lost the section. */
    if (!body.some(line => !line.inCode && TOP_LEVEL_BULLET.test(line.text))) {
      addIssue(
        `Card "${label}" is missing bullet items`,
        bodyLines.length > 0 ? bodyLines : [card.line],
      )
    }

    for (const line of body) {
      if (!line.inCode && EMPTY_BULLET.test(line.text)) {
        addIssue('Empty bullet item', [line.number])
      }
    }

    /* Canonical form puts a blank line either side of the separator (§5.3). Valid form
       does not require one, and a producer must not emit merely-valid output — so a
       separator written tight against its neighbours is rejected rather than normalized,
       which keeps the body verbatim. The body's own edges count as blank: the blank line
       after the heading, and the one before the next card, are both there. */
    body.forEach((line, index) => {
      if (line.inCode || line.text !== SEPARATOR) return

      const beforeIsBlank = index === 0 || !body[index - 1].text.trim()
      const afterIsBlank =
        index === body.length - 1 || !body[index + 1].text.trim()

      if (!beforeIsBlank || !afterIsBlank) {
        addIssue(
          'A "***" front/back separator needs a blank line either side',
          [line.number],
        )
      }
    })

    cards.push({
      front: card.front,
      body: body.map(line => line.text).join('\n'),
    })
  }

  for (const line of lines) {
    if (line.heading?.depth === 1) {
      close()
      /* The deck title is added by the CLI once, around this output; a `#` inside it
         would either duplicate the title or end a card (§5.1). Either way it is not the
         model's to write. */
      addIssue('A "#" heading belongs to the deck, not to a card', [
        line.number,
      ])
      continue
    }

    if (line.heading?.depth === 2) {
      close()
      const front = line.heading.text

      if (!front) {
        addIssue('Empty card front after "## "', [line.number])
      }

      /* §5.5 makes duplicate fronts valid, and a consumer must keep both. A producer may
         still refuse to write them, and this one does: two cards with the same front are
         the model repeating itself, and the user cannot tell them apart while reviewing. */
      const earlier = seenFronts.get(front)
      if (front && earlier !== undefined) {
        addIssue(
          `Duplicate card front "${front}" (already used on line ${earlier})`,
          [line.number],
        )
      } else if (front) {
        seenFronts.set(front, line.number)
      }

      open = { front, line: line.number, body: [] }
      continue
    }

    if (open) {
      open.body.push(line)
      continue
    }

    /* Content above the first `## ` is a preamble, which belongs to no card (§4.3) and
       would be dropped by whatever reads the deck. The old scanner dropped it here
       instead, which is the same loss one step earlier. */
    if (line.text.trim()) {
      addIssue('Content found before the first card front', [line.number])
    }
  }

  close()

  if (cards.length === 0) {
    const nonEmptyLines = lines
      .filter(line => line.text.trim().length > 0)
      .map(line => line.number)
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

/**
 * The canonical serializer.
 *
 * Canonical form puts a blank line between the heading and the body (§5.4), which is
 * what markdownlint's MD022 wants and therefore what keeps a generated deck from being
 * lint-dirty inside the user's vault. Bodies are written back exactly as they were read,
 * so a canonical deck parsed and re-rendered is byte-identical.
 */
export function renderFlashcards(cards: Flashcard[]): string {
  return cards
    .map(card =>
      card.body ? `## ${card.front}\n\n${card.body}` : `## ${card.front}`,
    )
    .join('\n\n')
    .trim()
}
