/** Something that happened in the domain; past tense, immutable. */
export interface DomainEvent<Type extends string = string> {
  readonly type: Type;
  readonly aggregateId: string;
  /** Epoch milliseconds. */
  readonly occurredAt: number;
}

/** Collects events while a command runs; the application publishes them after saving. */
export abstract class AggregateRoot<Event extends DomainEvent> {
  #events: Event[] = [];

  protected record(event: Event): void {
    this.#events.push(event);
  }

  pullEvents(): Event[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }
}
