export interface ReadSnapshot {
  content: string;
  timestamp: number;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
}

const readSnapshots = new Map<string, ReadSnapshot>();

export function getReadSnapshot(filePath: string): ReadSnapshot | undefined {
  return readSnapshots.get(filePath);
}

export function setReadSnapshot(filePath: string, snapshot: ReadSnapshot): void {
  readSnapshots.set(filePath, snapshot);
}

export function clearReadSnapshot(filePath: string): void {
  readSnapshots.delete(filePath);
}
