import type { PrincipalId } from '../shared';

/** `client`: an installation of the vdoc app holding an API key. `user`: a signed-in person (future). */
export type PrincipalKind = 'client' | 'user';

/** Whoever asked for a voice session. Sessions belong to exactly one principal. */
export interface Principal {
  readonly id: PrincipalId;
  readonly kind: PrincipalKind;
  readonly name: string;
}
