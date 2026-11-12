import assert from "node:assert/strict";
import test from "node:test";

import { findPageOverlaps } from "../dist/pdfSummary.js";

/*
 * The overlap warning a PDF extraction prints when the index it was given claims
 * the same page twice. Only sections carrying a parseable `<start>-<end>` range
 * take part; anything else is not a claim about pages and cannot conflict.
 */

const section = (index, pageRange, title) => ({
  index,
  ...(title === undefined ? {} : { title }),
  ...(pageRange === undefined ? {} : { pageRange }),
  text: "body",
});

test("findPageOverlaps finds nothing in ranges that only touch", () => {
  const overlaps = findPageOverlaps([section(1, "1-10"), section(2, "11-20")]);

  assert.deepEqual(overlaps, []);
});

test("findPageOverlaps reports the pages two ranges share", () => {
  const overlaps = findPageOverlaps([section(1, "1-10", "One"), section(2, "8-20", "Two")]);

  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0], {
    leftTitle: "One",
    leftRange: "1-10",
    rightTitle: "Two",
    rightRange: "8-20",
    overlapStart: 8,
    overlapEnd: 10,
  });
});

test("findPageOverlaps reports a single shared page", () => {
  const [overlap] = findPageOverlaps([section(1, "1-10"), section(2, "10-20")]);

  assert.equal(overlap.overlapStart, 10);
  assert.equal(overlap.overlapEnd, 10);
});

test("findPageOverlaps reports a range contained in another", () => {
  const [overlap] = findPageOverlaps([section(1, "1-100"), section(2, "40-50")]);

  assert.equal(overlap.overlapStart, 40);
  assert.equal(overlap.overlapEnd, 50);
});

test("findPageOverlaps compares every pair once", () => {
  const overlaps = findPageOverlaps([section(1, "1-10"), section(2, "5-15"), section(3, "9-20")]);

  assert.deepEqual(
    overlaps.map((overlap) => [overlap.leftRange, overlap.rightRange]),
    [
      ["1-10", "5-15"],
      ["1-10", "9-20"],
      ["5-15", "9-20"],
    ],
  );
});

test("findPageOverlaps names a section without a title by its index", () => {
  const [overlap] = findPageOverlaps([section(3, "1-10"), section(4, "5-15", "   ")]);

  assert.equal(overlap.leftTitle, "Section 3");
  assert.equal(overlap.rightTitle, "Section 4");
});

test("findPageOverlaps skips sections with no page range", () => {
  const overlaps = findPageOverlaps([section(1), section(2, "1-10"), section(3, "5-15")]);

  assert.equal(overlaps.length, 1);
});

test("findPageOverlaps skips ranges it cannot parse", () => {
  const overlaps = findPageOverlaps([
    section(1, "1-10"),
    section(2, "5"),
    section(3, "5 - 15"),
    section(4, "five-fifteen"),
  ]);

  assert.deepEqual(overlaps, []);
});
