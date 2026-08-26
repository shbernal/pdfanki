import {
  type CanonicalIssue,
  type Card,
  formatIssues,
  parseMarkdown,
  scanLines,
  splitSourceLines,
} from '@ankimd/core'

/*
 * pdfanki's producer policy over one model response.
 *
 * The grammar is not here. `@ankimd/core` owns Flashcard Markdown
 * (https://github.com/shbernal/flashcard-md-spec) in both directions, and what it
 * reports as a diagnostic is what the format itself rejects. What is left for this file
 * is the set §5.5 hands to the producer: rules a conforming deck may break but pdfanki's
 * own output may not.
 *
 * Everything throws, because the input is an LLM's output for one section. A failure
 * means "ask again", not "give the user a broken deck".
 *
 * What is deliberately *not* rejected is a departure the renderer fixes on its own. A
 * missing blank line after a heading and a `***` written tight against its neighbours
 * are both merely valid rather than canonical, and both come back canonical because the
 * deck is written by `renderMarkdown` rather than by echoing the model's text. Retrying
 * the model over whitespace it will probably reproduce costs a call and buys nothing.
 */

/** A body line that opens a top-level list item, which is what the prompt asks for. */
const TOP_LEVEL_BULLET = /^[-*+][ \t]+\S/
const EMPTY_BULLET = /^[-*+][ \t]*$/

const hasBullet = (body: string): boolean =>
  scanLines(splitSourceLines(body)).some(
    line => !line.inCode && TOP_LEVEL_BULLET.test(line.text),
  )

/**
 * Every empty list item in the response, by absolute line.
 *
 * Checked over the whole source rather than per card: an empty bullet is wrong wherever
 * it is, and the line number is more use to a reader than the card's name.
 */
const emptyBullets = (markdown: string): CanonicalIssue[] =>
  scanLines(splitSourceLines(markdown))
    .filter(line => !line.inCode && EMPTY_BULLET.test(line.text))
    .map(line => ({ message: 'Empty bullet item', lines: [line.number] }))

const label = (card: Card): string => card.headingText || '(empty front)'

/**
 * §5.4 makes a bullet-list back an authoring convention rather than a grammar rule, so
 * a bullet-less card is valid and a consumer must keep it. Refusing to *write* one is a
 * different thing: an answer with nothing in it means the model lost the section.
 */
const missingBullets = (cards: readonly Card[]): CanonicalIssue[] =>
  cards
    .filter(card => !hasBullet(card.frontBody) && !hasBullet(card.back))
    .map(card => ({
      message: `Card "${label(card)}" is missing bullet items`,
      lines: [],
    }))

/**
 * §5.5 makes duplicate fronts valid, and a consumer must keep both. A producer may
 * still refuse to write them, and this one does: two cards with the same front are the
 * model repeating itself, and the user cannot tell them apart while reviewing.
 */
const duplicateFronts = (cards: readonly Card[]): CanonicalIssue[] => {
  const seen = new Set<string>()

  return cards
    .filter(card => {
      const front = card.headingText
      if (!front) return false
      if (seen.has(front)) return true
      seen.add(front)
      return false
    })
    .map(card => ({
      message: `Duplicate card front "${card.headingText}"`,
      lines: [],
    }))
}

/**
 * Reads one model response into cards, or throws with everything wrong with it.
 *
 * The response is a card region and nothing else: the frontmatter and the `# ` deck
 * title are written by the CLI, around this.
 */
export function parseSectionCards(markdown: string): Card[] {
  const { deck, diagnostics } = parseMarkdown(markdown)
  const cards = [...deck.cards]

  const issues: CanonicalIssue[] = [
    ...diagnostics.map(item => ({
      message: `${item.code}: ${item.message}`,
      lines: [],
    })),
    ...missingBullets(cards),
    ...emptyBullets(markdown),
    ...duplicateFronts(cards),
  ]

  /* §4.3 makes a preamble legal and gives it to no card, so whatever reads the deck
     drops it. The CLI writes what belongs above the first card, and anything the model
     puts there is content it meant for a card and would silently lose. */
  if (deck.preamble !== null) {
    issues.push({
      message: 'Content found before the first card front',
      lines: [],
    })
  }

  if (cards.length === 0) {
    issues.push({
      message: 'No flashcards detected (expected lines starting with "## ")',
      lines: [],
    })
  }

  if (issues.length > 0) {
    throw new Error(`Markdown validation failed:\n${formatIssues(issues)}`)
  }

  return cards
}
