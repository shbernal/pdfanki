import type {
  BookJson,
  ContentSection,
  ConvertFileOptions,
  ConvertFileResult,
  EpubTitleFilter,
  SupportedProvider,
} from '@shbernal/pdfanki/server'

type ServerModule = typeof import('@shbernal/pdfanki/server')
type ClientModule = typeof import('@shbernal/pdfanki/client')

const useWorkspaceSource = process.env.PDFANKI_LOCAL_DEV === '1'

const serverModule: ServerModule = useWorkspaceSource
  ? await import('../../packages/pdfanki/src/server.js')
  : await import('@shbernal/pdfanki/server')

const clientModule: ClientModule = useWorkspaceSource
  ? await import('../../packages/pdfanki/src/client.js')
  : await import('@shbernal/pdfanki/client')

export type {
  BookJson,
  ContentSection,
  ConvertFileOptions,
  ConvertFileResult,
  EpubTitleFilter,
  SupportedProvider,
}

export const {
  DEFAULT_EPUB_TITLE_FILTERS,
  bookJsonToPlainText,
  convertFileFromPath,
  generateFlashcards,
} = serverModule

export const { validateJsonStructure } = clientModule
