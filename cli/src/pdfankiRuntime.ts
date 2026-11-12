type ServerModule = typeof import("@shbernal/pdfanki/server");
type ClientModule = typeof import("@shbernal/pdfanki/client");

const useWorkspaceSource = process.env.PDFANKI_LOCAL_DEV === "1";

const serverModule: ServerModule = useWorkspaceSource
  ? await import("../../packages/pdfanki/src/server.js")
  : await import("@shbernal/pdfanki/server");

const clientModule: ClientModule = useWorkspaceSource
  ? await import("../../packages/pdfanki/src/client.js")
  : await import("@shbernal/pdfanki/client");

export type {
  BookJson,
  ContentSection,
  ConvertFileOptions,
  ConvertFileResult,
  EpubTitleFilter,
  ReadonlyBookJson,
  ReadonlyContentSection,
  SupportedProvider,
} from "@shbernal/pdfanki/server";

/* Annotated one by one rather than destructured. Left to itself TypeScript
   traces each re-exported binding back to the file that declares it and writes
   that path into the `.d.ts` - `@shbernal/pdfanki/providers.js` and friends,
   which the package's `exports` map does not answer for. An explicit
   annotation is what the declaration emitter prints, so every specifier here
   stays one an importer can resolve. */
export const DEFAULT_EPUB_TITLE_FILTERS: ServerModule["DEFAULT_EPUB_TITLE_FILTERS"] =
  serverModule.DEFAULT_EPUB_TITLE_FILTERS;
export const convertFileFromPath: ServerModule["convertFileFromPath"] =
  serverModule.convertFileFromPath;
export const generateFlashcards: ServerModule["generateFlashcards"] =
  serverModule.generateFlashcards;

export const isBookJson: ClientModule["isBookJson"] = clientModule.isBookJson;
export const validateJsonStructure: ClientModule["validateJsonStructure"] =
  clientModule.validateJsonStructure;
