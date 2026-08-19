export interface CarsonTurnResponse {
  handled: boolean;
  ownerResult?: string;
  code?: string;
}

export async function dispatchCarsonReadTurn({
  request,
  legacyFallback,
}: {
  request: () => Promise<CarsonTurnResponse>;
  legacyFallback: () => Promise<string>;
}): Promise<{ ownerResult: string; owner: "turn_coordinator" | "legacy" }> {
  const result = await request();
  if (result.handled) {
    return {
      ownerResult: result.ownerResult ?? "I couldn't complete that read-only request.",
      owner: "turn_coordinator",
    };
  }
  return { ownerResult: await legacyFallback(), owner: "legacy" };
}
