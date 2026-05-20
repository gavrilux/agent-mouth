export interface OffsetStore {
  getOffset(handle: string): Promise<number>;
  saveOffset(handle: string, updateId: number): Promise<void>;
}
