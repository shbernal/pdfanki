#!/usr/bin/env node

const args = process.argv.slice(2)
const input = await new Promise((resolve, reject) => {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    value += chunk
  })
  process.stdin.on('end', () => resolve(value))
  process.stdin.on('error', reject)
})

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(64)
}

for (const required of [
  'exec',
  '--ephemeral',
  '--skip-git-repo-check',
  '--sandbox',
  'read-only',
  '-',
]) {
  if (!args.includes(required)) {
    fail(`missing expected fake codex arg: ${required}`)
  }
}

function optionValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function configValues() {
  const values = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--config') {
      values.push(args[index + 1])
    }
  }
  return values
}

const expectedModel = process.env.EXPECTED_CODEX_MODEL
if (expectedModel && optionValue('--model') !== expectedModel) {
  fail(
    `expected --model ${expectedModel}, received ${optionValue('--model') ?? '(missing)'}`,
  )
}

const expectedProfile = process.env.EXPECTED_CODEX_PROFILE
if (expectedProfile && optionValue('--profile') !== expectedProfile) {
  fail(
    `expected --profile ${expectedProfile}, received ${optionValue('--profile') ?? '(missing)'}`,
  )
}

const expectedReasoningEffort = process.env.EXPECTED_CODEX_REASONING_EFFORT
if (expectedReasoningEffort) {
  const expectedConfig = `model_reasoning_effort="${expectedReasoningEffort}"`
  if (!configValues().includes(expectedConfig)) {
    fail(`expected --config ${expectedConfig}`)
  }
}

if (!input.includes('Source text:')) {
  fail('missing source text block')
}

if (!input.includes('STORY OF THE DOOR')) {
  fail('missing expected book marker')
}

process.stdout.write(`## Codex provider fixture
- Fake Codex CLI consumed a public-domain EPUB section
- Source marker: STORY OF THE DOOR
`)
