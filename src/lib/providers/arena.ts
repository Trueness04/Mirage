export interface ScrapedArenaModel {
  modelKey: string
  displayName: string
  upstreamName?: string
  contextWindow?: number
}

export async function scrapeArenaModels(
  cookies: unknown[],
): Promise<ScrapedArenaModel[]> {
  // Stub implementation to satisfy dynamic import in model-import.ts
  return []
}
