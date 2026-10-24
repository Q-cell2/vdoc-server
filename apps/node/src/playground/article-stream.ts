import { tableCaption } from './table';
import { parse } from 'partial-json';
import type { ToolStreamEvent } from '@vrealtime/client';

type DocumentSnapshot = { docId: string; sessionId: string; revision: number; blocks: { id: string; kind: string; text: string }[] };
export type ArticlePreviewBlock = { kind: 'heading' | 'paragraph' | 'table'; text: string; level?: number; columns?: string[]; rows?: string[][]; caption?: string };
type Phase = 'streaming' | 'pending' | 'cancelled' | 'failed';
type Draft = { name: string; callId: string; base: DocumentSnapshot; raw: string; input?: unknown; phase: Phase };
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Display real argument deltas only. Never mutate the document or bypass its atomic tool. */
export function createArticleStream(read: () => DocumentSnapshot, changed: () => void) {
  let draft: Draft | undefined;
  const ended = new Set<string>();
  const end = (id: string) => { ended.add(id); if (ended.size > 256) ended.delete(ended.values().next().value!); };
  const begin = (callId: string, name: string) => {
    if (draft?.callId === callId) return draft;
    if (draft) end(draft.callId);
    return draft = { name, callId, base: read(), raw: '', phase: 'streaming' };
  };
  return {
    receive(event: ToolStreamEvent) {
      if (!['insert_structured_article', 'insert_test_table'].includes(event.name) || ended.has(event.callId)) return;
      const current = begin(event.callId, event.name);
      if (event.phase === 'arguments-delta') {
        if (current.raw.length + event.delta.length > 512_000) { current.phase = 'failed'; end(event.callId); }
        else { current.raw += event.delta; current.input = undefined; }
      } else if (event.phase === 'arguments-complete') {
        current.input = event.arguments; current.phase = 'pending';
      } else if (event.phase === 'cancelled' || event.phase === 'failed') {
        current.phase = event.phase; end(event.callId);
      } else if (event.phase === 'settled') {
        end(event.callId);
        if (event.ok) draft = undefined;
        else current.phase = 'failed';
      }
      changed();
    },
    finish(callId: string, ok: boolean) {
      if (draft?.callId !== callId || ended.has(callId)) return;
      end(callId);
      if (ok) draft = undefined;
      else draft.phase = 'failed';
      changed();
    },
    cancel() {
      if (!draft || ended.has(draft.callId)) return;
      draft.phase = 'cancelled'; end(draft.callId); changed();
    },
    clear() { if (draft) end(draft.callId); draft = undefined; changed(); },
    view() {
      if (!draft) return undefined;
      const current = read();
      if (current.docId !== draft.base.docId) return undefined;
      let input = record(draft.input);
      if (!input) { try { input = record(parse(draft.raw)); } catch { /* Partial escape / malformed JSON: keep waiting, never execute it. */ } }
      const stale = current.sessionId !== draft.base.sessionId || current.revision !== draft.base.revision
        || (typeof input?.expectedSessionId === 'string' && input.expectedSessionId !== current.sessionId)
        || (typeof input?.expectedRevision === 'number' && input.expectedRevision !== current.revision);
      const blocks: ArticlePreviewBlock[] = [];
      if (draft.name === 'insert_test_table') {
        const columns = Array.isArray(input?.columns) ? input.columns.slice(0, 12).map(cell => typeof cell === 'string' ? cell.slice(0, 100) : '') : [];
        const rows = Array.isArray(input?.rows) ? input.rows.slice(0, 200).filter(Array.isArray).map(row => row.slice(0, columns.length).map(cell => typeof cell === 'string' ? cell.slice(0, 1000) : '')) : [];
        if (columns.length) blocks.push({ kind: 'table', text: '', columns, rows, caption: tableCaption(typeof input?.title === 'string' ? input.title.slice(0, 200) : '', typeof input?.scopeNote === 'string' ? input.scopeNote.slice(0, 1000) : '范围说明生成中') });
      }
      if (draft.name !== 'insert_test_table' && typeof input?.title === 'string') blocks.push({ kind: 'heading', level: 1, text: input.title.slice(0, 200) });
      if (Array.isArray(input?.blocks)) {
        for (const raw of input.blocks.slice(0, 120)) {
          const block = record(raw);
          if (typeof block?.text !== 'string') continue;
          if (block.kind === 'paragraph') blocks.push({ kind: 'paragraph', text: block.text.slice(0, 4000) });
          else if (block.kind === 'heading') blocks.push({ kind: 'heading', level: block.level === 3 ? 3 : 2, text: block.text.slice(0, 4000) });
        }
      }
      let offset = current.blocks.length;
      const destination = record(input?.destination);
      let missingDestination = false;
      if (destination?.kind === 'before_block' || destination?.kind === 'after_block') {
        offset = current.blocks.findIndex(block => block.id === destination.blockId);
        missingDestination = offset < 0;
        if (destination.kind === 'after_block') offset++;
      }
      return { name: draft.name, callId: draft.callId, phase: draft.phase, stale: stale || missingDestination,
        blocks: stale || missingDestination ? [] : blocks, offset,
        replaceBlank: destination?.kind === 'document_end' && current.blocks.length === 1 && !current.blocks[0]!.text && current.blocks[0]!.kind === 'paragraph' };
    },
  };
}
