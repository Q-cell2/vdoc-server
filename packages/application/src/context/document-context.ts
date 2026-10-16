import { InstructionTemplate, type AgentProfile } from '@vdoc-server/domain';

/** What the app may tell the agent about the open document. Everything here is user data. */
export interface DocumentContext {
  readonly documentId: string | undefined;
  readonly title: string;
  readonly language: string;
  readonly vocabulary: readonly string[];
}

const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const MAX_TERM = 40;

/** Accepts any `hello.context` shape and keeps only bounded, well-typed fields. */
export function parseDocumentContext(raw: unknown, profile: AgentProfile): DocumentContext {
  const input = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const language = typeof input.language === 'string' && LANGUAGE.test(input.language) ? input.language : profile.defaultLanguage;
  const title = typeof input.title === 'string' ? InstructionTemplate.sanitize(input.title, 120) : '';
  const terms = Array.isArray(input.vocabulary) ? input.vocabulary : [];
  const vocabulary = [...new Set(terms
    .filter((term): term is string => typeof term === 'string')
    .map((term) => InstructionTemplate.sanitize(term, MAX_TERM))
    .filter((term) => term.length > 0))].slice(0, profile.maxVocabulary);
  return { documentId: typeof input.documentId === 'string' ? input.documentId : undefined, title, language, vocabulary };
}
