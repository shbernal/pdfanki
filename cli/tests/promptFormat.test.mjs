import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/*
 * The format rules are the same in every prompt, and they were four copies that had
 * already drifted — a project whose whole problem is that a format spec gets copied.
 *
 * They cannot be extracted into a shared partial: a prompt is one file the user owns in
 * their config directory, fetched whole from this repository, so there is nothing to
 * include at runtime. What is available instead is this — one place the rules are
 * written, and a test that fails when a prompt stops carrying them. Each prompt keeps
 * its own voice and its own content rules; only the lines below are shared.
 *
 * When a rule here changes, it changes in all four prompts. That is the point.
 */
const SHARED_FORMAT_RULES = [
  '- Return only Markdown flashcards; no deck title, no commentary, no wrappers',
  '- Each card front is a `##` heading; keep it concise and specific',
  '- Each card back is a bullet list starting with `-`; nest sub-items by indenting two spaces',
  '- Leave a blank line after each `##` heading and one between cards',
  '- Never emit a `#` heading; the deck title is added separately, and a `#` here would end the card above it',
]

const PROMPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts',
)

const promptFiles = readdirSync(PROMPTS_DIR).filter(name =>
  name.endsWith('.md'),
)

test('there are prompts to check', () => {
  assert.ok(promptFiles.length > 0)
})

for (const name of promptFiles) {
  test(`${name} carries every shared format rule`, () => {
    const contents = readFileSync(path.join(PROMPTS_DIR, name), 'utf8')

    for (const rule of SHARED_FORMAT_RULES) {
      assert.ok(
        contents.includes(rule),
        `${name} is missing or has reworded:\n  ${rule}`,
      )
    }
  })

  // The example at the top of every prompt is the model's strongest signal, so it has
  // to be canonical form itself: blank line after the heading, bullets below it.
  test(`${name} shows a canonical card as its example`, () => {
    const contents = readFileSync(path.join(PROMPTS_DIR, name), 'utf8')

    assert.match(contents, /## <front of card text>\n\n- Key point 1/)
  })
}
