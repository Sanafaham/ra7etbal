type SafeDebugData = Partial<{
  userExists: boolean;
  transcriptCount: number;
  userTurnCount: number;
  extractCalled: boolean;
  apiStarted: boolean;
  apiResponseOk: boolean;
  jsonParseOk: boolean;
  validatedFactsCount: number;
  upsertAttemptedCount: number;
  upsertSuccess: boolean;
  errorMessage: string;
}>;

export function sendCarsonDebug(event: string, data: SafeDebugData = {}): void {
  void fetch("/api/carson-debug", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, data }),
  }).catch(() => {
    // Temporary diagnostics must never affect Carson memory flow.
  });
}
