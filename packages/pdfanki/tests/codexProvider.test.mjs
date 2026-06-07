import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCodexExecArgs,
  buildCodexExecPrompt,
  callCodexProvider,
} from '../dist/server.js'

test('buildCodexExecArgs uses non-interactive read-only codex exec flags', () => {
  const args = buildCodexExecArgs('gpt-test')

  assert.deepEqual(args, [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '--model',
    'gpt-test',
    '-',
  ])
})

test('buildCodexExecArgs applies Codex profile and reasoning effort overrides', () => {
  const args = buildCodexExecArgs({
    model: 'gpt-test',
    profile: 'flashcards_high',
    reasoningEffort: 'high',
  })

  assert.deepEqual(args, [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '--profile',
    'flashcards_high',
    '--model',
    'gpt-test',
    '--config',
    'model_reasoning_effort="high"',
    '-',
  ])
})

test('buildCodexExecPrompt scopes Codex to the prompt and section text', () => {
  const prompt = buildCodexExecPrompt({
    prompt: 'Create terse flashcards.',
    content: 'STORY OF THE DOOR',
  })

  assert.match(prompt, /experimental pdfanki flashcard-generation provider/)
  assert.match(prompt, /Do not inspect files, run commands, or modify/)
  assert.match(prompt, /Create terse flashcards\./)
  assert.match(prompt, /STORY OF THE DOOR/)
})

test('callCodexProvider delegates to the runner and returns trimmed stdout', async () => {
  let captured = null

  const output = await callCodexProvider({
    prompt: 'Create one card.',
    content: 'Spaced repetition improves retention.',
    model: 'gpt-test',
    reasoningEffort: 'medium',
    runner: async (args, input, options) => {
      captured = { args, input, options }
      return {
        stdout: '\n## Spaced repetition\n- Increasing review intervals\n',
        stderr: '',
        exitCode: 0,
        signal: null,
      }
    },
  })

  assert.equal(output, '## Spaced repetition\n- Increasing review intervals')
  assert.ok(captured)
  assert.equal(captured.options.command, 'codex')
  assert.equal(captured.options.timeoutMs, 600_000)
  assert.deepEqual(captured.args.slice(-5), [
    '--model',
    'gpt-test',
    '--config',
    'model_reasoning_effort="medium"',
    '-',
  ])
  assert.match(captured.input, /Create one card\./)
  assert.match(captured.input, /Spaced repetition improves retention\./)
})

test('callCodexProvider redacts sensitive stderr when codex fails', async () => {
  await assert.rejects(
    () =>
      callCodexProvider({
        prompt: 'Create one card.',
        content: 'Source text.',
        runner: async () => ({
          stdout: '',
          stderr: 'OPENAI_API_KEY=sk-testtesttesttest Bearer abc.def_123456789',
          exitCode: 1,
          signal: null,
        }),
      }),
    error => {
      assert.match(error.message, /Codex CLI provider failed with exit code 1/)
      assert.doesNotMatch(error.message, /sk-testtesttesttest/)
      assert.doesNotMatch(error.message, /abc\.def_123456789/)
      assert.match(error.message, /OPENAI_API_KEY=\[redacted\]/)
      assert.match(error.message, /Bearer \[redacted\]/)
      return true
    },
  )
})
