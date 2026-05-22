import type { ContactStore } from "@agent-mouth/core";

export class EpisodicMemoryBuilder {
  constructor(private readonly contacts: ContactStore) {}

  async build(workspaceId: string, contactId: string): Promise<string> {
    const c = await this.contacts.findById(workspaceId, contactId);
    return c?.notes ?? "";
  }
}
