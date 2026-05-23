import type { MessageStore, PersistedMessage } from "@agent-mouth/core";

export class WorkingMemoryBuilder {
  constructor(
    private readonly messages: MessageStore,
    private readonly windowSize = 10,
  ) {}

  async build(threadId: string): Promise<PersistedMessage[]> {
    return this.messages.lastN(threadId, this.windowSize);
  }
}
