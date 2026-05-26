import type { ChannelType, Transport } from "@agent-mouth/core";

export class TransportRegistry {
  private byType = new Map<ChannelType, Transport>();

  register(type: ChannelType, transport: Transport): void {
    this.byType.set(type, transport);
  }

  get(type: ChannelType): Transport {
    const t = this.byType.get(type);
    if (!t) throw new Error(`no transport registered for channel type "${type}"`);
    return t;
  }

  has(type: ChannelType): boolean {
    return this.byType.has(type);
  }

  list(): ChannelType[] {
    return [...this.byType.keys()];
  }
}
