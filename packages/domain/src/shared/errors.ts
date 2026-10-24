/** A broken business rule. `code` is stable; edges map it to transport errors. */
export interface DomainError<Code extends string = string> {
  readonly code: Code;
  readonly message: string;
}

export const domainError = <Code extends string>(code: Code, message: string): DomainError<Code> => ({ code, message });
