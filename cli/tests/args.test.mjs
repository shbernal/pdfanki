import assert from "node:assert/strict";
import test from "node:test";

import { getPreviewFlagMode, normalizePreviewCliArgs } from "../dist/args.js";

/*
 * The two argv rewrites yargs cannot express.
 *
 * `--preview` is declared as a boolean, so `--preview 200` would leave the 200
 * as a stray positional. `normalizePreviewCliArgs` rewrites it into the pair
 * yargs does understand, before yargs ever sees the array - which is why
 * `getPreviewFlagMode` has to read the original argv rather than the parsed one.
 */

test("normalizePreviewCliArgs leaves an argv without --preview alone", () => {
  const args = ["pdf", "md", "book.pdf", "--out", "deck.md"];

  assert.deepEqual(normalizePreviewCliArgs(args), args);
});

test("normalizePreviewCliArgs rewrites --preview <count> into a flag and a count", () => {
  assert.deepEqual(normalizePreviewCliArgs(["--preview", "200"]), [
    "--preview",
    "--preview-chars",
    "200",
  ]);
});

test("normalizePreviewCliArgs rewrites --preview=<count> the same way", () => {
  assert.deepEqual(normalizePreviewCliArgs(["--preview=200"]), [
    "--preview",
    "--preview-chars",
    "200",
  ]);
});

test("normalizePreviewCliArgs leaves a bare --preview as a boolean flag", () => {
  assert.deepEqual(normalizePreviewCliArgs(["--preview", "book.epub"]), ["--preview", "book.epub"]);
});

test("normalizePreviewCliArgs only claims a following argument that is all digits", () => {
  assert.deepEqual(normalizePreviewCliArgs(["--preview", "20a"]), ["--preview", "20a"]);
  assert.deepEqual(normalizePreviewCliArgs(["--preview", "-5"]), ["--preview", "-5"]);
  assert.deepEqual(normalizePreviewCliArgs(["--preview=false"]), ["--preview=false"]);
});

test("normalizePreviewCliArgs rewrites every occurrence", () => {
  assert.deepEqual(normalizePreviewCliArgs(["--preview", "10", "--preview=20"]), [
    "--preview",
    "--preview-chars",
    "10",
    "--preview",
    "--preview-chars",
    "20",
  ]);
});

test("getPreviewFlagMode reports an untyped flag as unset", () => {
  assert.equal(getPreviewFlagMode(["epub", "md", "book.epub"]), "unset");
});

test("getPreviewFlagMode reports both spellings of on", () => {
  assert.equal(getPreviewFlagMode(["--preview"]), "enabled");
  assert.equal(getPreviewFlagMode(["--preview=200"]), "enabled");
});

test("getPreviewFlagMode reports both spellings of off", () => {
  assert.equal(getPreviewFlagMode(["--no-preview"]), "disabled");
  assert.equal(getPreviewFlagMode(["--preview=false"]), "disabled");
});

test("getPreviewFlagMode answers with the first spelling it meets", () => {
  assert.equal(getPreviewFlagMode(["--no-preview", "--preview"]), "disabled");
  assert.equal(getPreviewFlagMode(["--preview", "--no-preview"]), "enabled");
});
