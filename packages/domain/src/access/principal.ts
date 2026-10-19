import type { PrincipalId } from '../shared';

/** A verified application, or a signed-in user asserted by that application. */
export type PrincipalKind = 'client' | 'user';

/** Whoever asked for a voice session. Sessions belong to exactly one principal. */
export interface Principal {
  readonly id: PrincipalId;
  readonly kind: PrincipalKind;
  readonly name: string;
  readonly clientId?: string;
  readonly userId?: string;
}
