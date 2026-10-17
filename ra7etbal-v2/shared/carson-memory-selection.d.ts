export const RECAP_PREFIX: string;
export const SESSION_HISTORY_HEADER: string;
export const PERSISTENT_INSTRUCTIONS_HEADER: string;
export const PERSISTENT_INSTRUCTIONS_ORDER_NOTE: string;
export const USER_MEMORY_HEADER_LINES: string[];
export const DEFAULT_FACT_LIMIT: number;
export const DEFAULT_FACT_CHAR_BUDGET: number;
export const DEFAULT_INSTRUCTION_LIMIT: number;

export interface MemoryPersonRow {
  id?: string;
  name?: string | null;
}

export interface PeopleIndex {
  byToken: Map<string, Set<string>>;
  entries: Array<{ key: string; full: string; tokens: string[]; first: string }>;
}

export interface MemorySubject {
  people: string[];
  core: string[];
  classes: string[];
  values: string[];
  cue: boolean;
  preference: boolean;
  additive: boolean;
  key: string | null;
}

export interface InstructionRow {
  id?: string;
  user_id?: string | null;
  category?: string | null;
  instruction: string;
  source?: string | null;
  confirmed_at?: string | null;
  created_at?: string | null;
}

export interface FactRow {
  id?: string;
  user_id?: string | null;
  category: string;
  key: string;
  value: string;
  confidence?: number | null;
  source?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_seen_at?: string | null;
  archived_at?: string | null;
}

export interface MemoryItem {
  id: string;
  kind: "instruction" | "fact";
  text: string;
  peopleText?: string;
  at: number;
  authority: number;
}

export function tokenizeMemoryText(text: string): string[];
export function buildPeopleIndex(people: MemoryPersonRow[] | null | undefined): PeopleIndex;
export function memorySubject(text: string, peopleIndex?: PeopleIndex, peopleText?: string): MemorySubject;
export function isSameMemorySubject(
  a: string | MemorySubject,
  b: string | MemorySubject,
  peopleIndex?: PeopleIndex,
): boolean;
export function resolveCurrentMemories(
  items: MemoryItem[],
  peopleIndex?: PeopleIndex,
): { currentIds: Set<string>; supersededBy: Map<string, string> };
export function ownedRows<T extends { user_id?: string | null }>(rows: T[] | null | undefined, ownerId?: string | null): T[];
export function selectRelevantFacts<T extends FactRow>(
  factRows: T[],
  opts?: {
    contextText?: string;
    peopleIndex?: PeopleIndex;
    limit?: number;
    charBudget?: number;
    now?: number;
    pinnedRows?: Set<T>;
  },
): T[];
export function formatUserMemoryBlock(facts: Array<Pick<FactRow, "category" | "key" | "value">>): string;

export interface CarsonMemoryContextInput {
  ownerId?: string | null;
  instructions?: InstructionRow[] | null;
  facts?: FactRow[] | null;
  people?: MemoryPersonRow[] | null;
  contextText?: string;
  now?: number;
  factLimit?: number;
  instructionLimit?: number;
  staleDays?: number;
}

export interface CarsonMemoryContext {
  persistentInstructions: string;
  userMemory: string;
  currentInstructions: InstructionRow[];
  selectedFacts: FactRow[];
  supersededInstructionIds: string[];
  supersededFactIds: string[];
}

export function buildCarsonMemoryContext(input?: CarsonMemoryContextInput): CarsonMemoryContext;
export function findFactsSupersededBy(
  existingFacts: FactRow[] | null | undefined,
  newFacts: Array<Pick<FactRow, "category" | "key" | "value">>,
  people?: MemoryPersonRow[] | null,
): string[];

export function isRecapRow(summary: unknown): boolean;
export function formatSessionRecaps(
  rows: Array<{ created_at: string; summary: string }> | null | undefined,
  opts?: { staleDays?: number; now?: number; locale?: string; timeZone?: string },
): string;

export function mergePersonMemoryNotes(
  existing: string | null | undefined,
  addition: string,
): { notes: string; changed: boolean; replaced: string[] };
export function renderPersonNotesForContext(notes: string | null | undefined, budget: number): string;

export function supersedes(newer: MemorySubject, older: MemorySubject): boolean;
