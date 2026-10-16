import { domainError, type DomainError } from './errors';
import { err, ok, type Result } from './result';

declare const brand: unique symbol;
/** A string that has passed validation for one kind of identifier. */
export type Id<Kind extends string> = string & { readonly [brand]: Kind };

const PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface IdKind<Kind extends string> {
  /** Validates untrusted input (HTTP, tokens, provider payloads). */
  parse(value: unknown): Result<Id<Kind>, DomainError<'INVALID_ID'>>;
  /** For values the system generated itself. */
  assume(value: string): Id<Kind>;
}

function idKind<Kind extends string>(label: string): IdKind<Kind> {
  return {
    parse: (value) => typeof value === 'string' && PATTERN.test(value)
      ? ok(value as Id<Kind>)
      : err(domainError('INVALID_ID', `Invalid ${label}.`)),
    assume: (value) => value as Id<Kind>,
  };
}

export type DocumentId = Id<'DocumentId'>;
export const DocumentId = idKind<'DocumentId'>('document id');
export type VoiceSessionId = Id<'VoiceSessionId'>;
export const VoiceSessionId = idKind<'VoiceSessionId'>('voice session id');
export type PrincipalId = Id<'PrincipalId'>;
export const PrincipalId = idKind<'PrincipalId'>('principal id');
export type ProfileId = Id<'ProfileId'>;
export const ProfileId = idKind<'ProfileId'>('profile id');
export type ToolCallId = Id<'ToolCallId'>;
export const ToolCallId = idKind<'ToolCallId'>('tool call id');
export type TurnId = Id<'TurnId'>;
export const TurnId = idKind<'TurnId'>('turn id');
