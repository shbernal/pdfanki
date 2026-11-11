/**
 * A rule, not a record: a filter is written once and only ever read against a
 * chapter title, so both variants and the list of them are readonly.
 */
export type EpubTitleFilter =
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "regex"; readonly pattern: string; readonly flags?: string };

export interface EpubFilters {
  readonly titles?: readonly EpubTitleFilter[];
}

// Default filters mirror the previous hardcoded patterns.
export const DEFAULT_EPUB_TITLE_FILTERS: readonly EpubTitleFilter[] = [
  { type: "regex", pattern: "^contents?$", flags: "i" },
  { type: "regex", pattern: "^dedication$", flags: "i" },
  { type: "regex", pattern: String.raw`^about\s+the\s+.+$`, flags: "i" },
  { type: "regex", pattern: String.raw`^also\s+by\s+.+$`, flags: "i" },
  { type: "regex", pattern: "^index$", flags: "i" },
  { type: "regex", pattern: "^credits$", flags: "i" },
  { type: "regex", pattern: "^copyright$", flags: "i" },
  { type: "regex", pattern: "^notes$", flags: "i" },
  { type: "regex", pattern: String.raw`^notes\s+on\s+sources$`, flags: "i" },
  { type: "regex", pattern: "^bibliography$", flags: "i" },
  { type: "regex", pattern: "^acknowledg(e)?ments?$", flags: "i" },
  {
    type: "regex",
    pattern: String.raw`^acknowledg(e)?ments?\s+and\s+notes\s+on\s+sources$`,
    flags: "i",
  },
  { type: "regex", pattern: "^frontispiece$", flags: "i" },
  { type: "regex", pattern: "^welcome$", flags: "i" },
  { type: "regex", pattern: String.raw`^title\s+page$`, flags: "i" },
  { type: "regex", pattern: String.raw`^table\s+of\s+contents$`, flags: "i" },
  { type: "regex", pattern: "^newsletters?$", flags: "i" },
  { type: "regex", pattern: String.raw`^praise\s+of(?:\s+.+)?$`, flags: "i" },
  { type: "regex", pattern: String.raw`^a\s+note\s+on\s+the\s+author$`, flags: "i" },
  { type: "regex", pattern: String.raw`^author['’]s\s+note$`, flags: "i" },
  { type: "regex", pattern: String.raw`^illustration\s+credits$`, flags: "i" },
];
