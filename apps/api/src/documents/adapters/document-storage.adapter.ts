// Abstracts where document bytes actually live. The local-disk implementation below is
// the free/self-hosted default; a future S3-compatible adapter (MinIO, etc.) can
// implement this same interface without touching DocumentsService or the DB schema —
// storageKey stays an opaque string either way.
export interface DocumentStorageAdapter {
  save(buffer: Buffer, suggestedFileName: string): Promise<string>; // returns storageKey
  read(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
}
