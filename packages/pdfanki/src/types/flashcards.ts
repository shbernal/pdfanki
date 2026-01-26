export type IndexEntry = {
  title: string
  start: number
  end: number
  index?: number
}

export type BookMetadata = {
  title?: string
  author?: string
  fileType?: string
  hasIndex?: boolean
  indexChapters?: number
  totalPages?: number
  totalSections?: number
  extractedRange?: string
  extractedSections?: number
  filteredSections?: number
  processingMethod?: string
}

export type ContentSection = {
  index: number
  title?: string
  text?: string
  pageRange?: string
  pageCount?: number
}

export type BookJson = {
  metadata?: BookMetadata
  content: ContentSection[]
}
