/**
 * EVIDENCE ONLY — frozen V3 extraction truth set. FROZEN BEFORE ANY MODEL RUN.
 *
 * Sources: the C-02 owner rulings on Main (2026-09-30) and the owner policy
 * rulings of 2026-10-01 (policy authority; family + operational work;
 * other roles; presence coordination; "Ask Loulya to call me" = DIRECT), the
 * protected C-02 examples, and the V1/V2 corpora. Nothing is derived from
 * model output. Do not edit after model runs.
 *
 * Each responsibility is frozen as MEANING plus its expected NATURE (what the
 * owner is doing with it). Carson instructions are frozen as EXPLICIT owner
 * instructions only; each inner list holds acceptable equivalent types.
 * Anchors and `forbidden` are evaluation-only flags, never runtime.
 */
import type { FrozenAnchor, Person } from "./anchors";
import type { Route } from "./policy";
import type { ClarificationReason, InstructionType, Nature } from "./skill";

export const OWNER_NAME = "Sana"; // authoritative display name, used verbatim in every language (recorded data assumption)

export const OWNER_PEOPLE: Person[] = [
  { name: "Christopher", aliases: ["christopher", "كريستوفر"], relationship: "staff" },
  { name: "Grace", aliases: ["grace", "غريس", "جريس"], relationship: "staff" },
  { name: "Ghulam", aliases: ["ghulam", "غلام"], relationship: "staff" },
  { name: "Nasira", aliases: ["nasira", "نصيرة", "نصيره"], relationship: "staff" },
  { name: "Loulya", aliases: ["loulya", "لوليا"], relationship: "family" },
  { name: "Ahmed", aliases: ["ahmed", "احمد"], relationship: "vendor" },
  { name: "Dana", aliases: ["dana", "دانة", "دانه"], relationship: "friend" },
];
/** Belongs to a different owner (tenant-isolation fixture). */
export const OTHER_OWNER_PEOPLE: Person[] = [{ name: "Maria", aliases: ["maria", "ماريا"], relationship: "staff" }];

export type Lang = "en" | "ar" | "mixed";

export interface ExpectedResponsibility {
  meaning: string;
  nature: Nature;
  /** Also satisfied if, instead of a responsibility, the owner-facing part is carried by one of these explicit Carson instructions. */
  orCarsonInstruction?: InstructionType[];
}

type Body = { route: Route; recipient: string; responsibilities: ExpectedResponsibility[]; instructions: InstructionType[][] };
export type Expected =
  | ({ outcome: "SEND" } & Body)
  | ({ outcome: "HOLD" } & Body)
  | { outcome: "CLARIFY"; reason: ClarificationReason }
  | ({ outcome: "SEND_OR_CLARIFY"; clarifyReason: ClarificationReason } & Body);

export interface V3Case {
  id: string;
  source: string;
  lang: Lang;
  compound: boolean;
  /** C-02-critical: 10 runs per model in the future gate. */
  critical: boolean;
  u: string;
  expected: Expected;
  anchors: FrozenAnchor[];
  /** Carson orchestration that must never reach the recipient (evaluation flag only). */
  forbidden: string[];
}

const OP: Nature = "operational_outcome";
const INFO: Nature = "information";
const PM: Nature = "personal_message";
const PRES: Nature = "presence_coordination";
const R = (meaning: string, nature: Nature, orCarsonInstruction?: InstructionType[]): ExpectedResponsibility =>
  orCarsonInstruction ? { meaning, nature, orCarsonInstruction } : { meaning, nature };
const A = (type: FrozenAnchor["type"], ...any: string[]): FrozenAnchor => ({ type, any });
/** Any explicit custody instruction type is an acceptable extraction of "track / make sure / keep an eye / follow up". */
const CUSTODY: InstructionType[] = ["track", "follow_up", "make_sure", "confirm", "report_back"];
const REPORT: InstructionType[] = ["report_back"];

type Opt = { anchors?: FrozenAnchor[]; forbidden?: string[]; critical?: boolean; lang?: Lang };
function mk(outcome: "SEND" | "HOLD", id: string, source: string, u: string, route: Route, recipient: string, responsibilities: ExpectedResponsibility[], instructions: InstructionType[][], o: Opt): V3Case {
  return {
    id, source, u, lang: o.lang ?? "en", critical: o.critical ?? false,
    compound: responsibilities.length + instructions.length > 1,
    expected: { outcome, route, recipient, responsibilities, instructions },
    anchors: o.anchors ?? [], forbidden: o.forbidden ?? [],
  };
}
const send = (id: string, source: string, u: string, route: Route, recipient: string, r: ExpectedResponsibility[], i: InstructionType[][] = [], o: Opt = {}) => mk("SEND", id, source, u, route, recipient, r, i, o);
const hold = (id: string, source: string, u: string, route: Route, recipient: string, r: ExpectedResponsibility[], i: InstructionType[][], o: Opt = {}) => mk("HOLD", id, source, u, route, recipient, r, i, o);
const CRIT = { critical: true };

export const V3_CASES: V3Case[] = [
  // ── Authoritative C-02 + owner rulings — critical ────────────────────────
  send("A-T1", "authoritative-c02", "Ask Grace to call me.", "tracked", "Grace", [R("Grace calls Sana", OP)], [], CRIT),
  send("A-T2", "authoritative-c02", "Tell Grace to call me.", "tracked", "Grace", [R("Grace calls Sana", OP)], [], CRIT),
  send("A-T3", "authoritative-c02", "Ask Grace to call me now.", "tracked", "Grace", [R("Grace calls Sana now", OP)], [], { critical: true, anchors: [A("time", "now", "right away", "immediately")] }),
  send("A-T4", "authoritative-c02", "Ask Grace to call me from the office.", "tracked", "Grace", [R("Grace calls Sana from the office", OP)], [], { critical: true, anchors: [A("location", "office")] }),
  send("A-T5", "authoritative-c02", "Tell Grace to arrange the guest room.", "tracked", "Grace", [R("Grace arranges the guest room", OP)], [], { critical: true, anchors: [A("location", "guest room")] }),
  send("A-T6", "authoritative-c02", "Ask Christopher to bring the car around at 6.", "tracked", "Christopher", [R("Christopher brings the car around at 6", OP)], [], { critical: true, anchors: [A("time", "6", "six")] }),
  send("A-T7", "authoritative-c02", "Ask Christopher to make pizza.", "tracked", "Christopher", [R("Christopher makes pizza", OP)], [], CRIT),
  send("A-T8", "authoritative-c02", "Ask Christopher to clean the kitchen.", "tracked", "Christopher", [R("Christopher cleans the kitchen", OP)], [], { critical: true, anchors: [A("location", "kitchen")] }),
  send("A-T9", "protected", "Ask Ghulam to bring the car out.", "tracked", "Ghulam", [R("Ghulam brings the car out", OP)], [], CRIT),
  send("O-T1", "owner-ruling-2026-10-01", "Ask Loulya to pick up the dry cleaning.", "tracked", "Loulya", [R("Loulya picks up the dry cleaning (family member, operational outcome)", OP)], [], CRIT),
  send("O-T2", "owner-ruling-2026-10-01", "Tell Loulya I would like her to call me and make sure she does.", "tracked", "Loulya", [R("Sana would like Loulya to call her", PM)], [CUSTODY], { critical: true, forbidden: ["make sure she", "make sure you"] }),
  send("O-T3", "owner-ruling-2026-10-01", "Ask Loulya to call me and make sure she does.", "tracked", "Loulya", [R("Sana asks Loulya to call her (personal request)", PM)], [CUSTODY], { critical: true, forbidden: ["make sure she", "make sure you"] }),
  send("O-T4", "owner-ruling-2026-10-01", "Tell Nasira to wait until 8 and then clean the kitchen.", "tracked", "Nasira",
    [R("Nasira waits until 8", PRES), R("then Nasira cleans the kitchen", OP)], [], { critical: true, anchors: [A("time", "8", "eight"), A("location", "kitchen")] }),
  send("A-C1", "authoritative-c02 (compound)", "Ask Christopher to prepare lunch and tell Grace it is ready, and track this until he confirms.", "tracked", "Christopher",
    [R("Christopher prepares lunch", OP), R("Christopher tells Grace when it is ready", OP)], [CUSTODY],
    { critical: true, anchors: [A("person", "Grace")], forbidden: ["track", "until he confirms", "until you confirm"] }),
  send("A-D1", "authoritative-c02", "Tell Loulya I would like her to call me.", "direct", "Loulya", [R("Sana would like Loulya to call her (personal wish)", PM)], [], CRIT),
  send("O-D1", "owner-ruling-2026-10-01", "Ask Loulya to call me.", "direct", "Loulya", [R("Sana asks Loulya to call her (personal/family request)", PM)], [], CRIT),
  send("A-D2", "authoritative-c02", "Tell Christopher dinner is at eight.", "direct", "Christopher", [R("dinner is at eight", INFO)], [], { critical: true, anchors: [A("time", "8", "eight")] }),
  send("O-D2", "owner-ruling-2026-10-01", "Tell Christopher dinner is at 8.", "direct", "Christopher", [R("dinner is at 8", INFO)], [], { critical: true, anchors: [A("time", "8", "eight")] }),
  send("A-D3", "authoritative-c02", "Ask Christopher to meet me outside.", "direct", "Christopher", [R("Christopher meets Sana outside", PRES)], [], { critical: true, anchors: [A("location", "outside")] }),
  send("A-D4", "authoritative-c02", "Tell Christopher to wait for me in the kitchen.", "direct", "Christopher", [R("Christopher waits for Sana in the kitchen", PRES)], [], { critical: true, anchors: [A("location", "kitchen")] }),
  send("O-D3", "owner-ruling-2026-10-01", "Tell Nasira to wait until 8.", "direct", "Nasira", [R("Nasira waits until 8", PRES)], [], { critical: true, anchors: [A("time", "8", "eight")] }),

  // ── Other protected information / presence cases — critical ─────────────
  send("P-1", "protected", "Ask Christopher to prepare dinner at 7.", "tracked", "Christopher", [R("Christopher prepares dinner at 7", OP)], [], { critical: true, anchors: [A("time", "7", "seven")] }),
  send("P-2", "protected", "Have Christopher buy milk.", "tracked", "Christopher", [R("Christopher buys milk", OP)], [], CRIT),
  send("P-4", "protected", "Ask Christopher to check whether the guest room is ready.", "tracked", "Christopher", [R("Christopher checks whether the guest room is ready", OP)], [], { critical: true, anchors: [A("location", "guest room")] }),
  send("P-5", "protected", "Tell Ghulam to wait by the car for me.", "direct", "Ghulam", [R("Ghulam waits by the car for Sana", PRES)], [], { critical: true, anchors: [A("location", "car")] }),
  send("P-7", "protected", "Christopher, come to the kitchen now.", "direct", "Christopher", [R("Christopher comes to the kitchen now", PRES)], [], { critical: true, anchors: [A("location", "kitchen"), A("time", "now", "right away")] }),
  send("P-8", "protected", "Tell Grace I'm running late.", "direct", "Grace", [R("Sana is running late", INFO)], [], CRIT),
  send("P-9", "protected", "Tell Ghulam I'm on my way.", "direct", "Ghulam", [R("Sana is on her way", INFO)], [], CRIT),
  send("P-10", "protected", "Tell Christopher to meet me outside.", "direct", "Christopher", [R("Christopher meets Sana outside", PRES)], [], { critical: true, anchors: [A("location", "outside")] }),
  send("P-11", "protected", "Christopher, wait downstairs.", "direct", "Christopher", [R("Christopher waits downstairs", PRES)], [], { critical: true, anchors: [A("location", "downstairs")] }),
  send("P-12", "protected", "Tell Christopher to come upstairs.", "direct", "Christopher", [R("Christopher comes upstairs", PRES)], [], { critical: true, anchors: [A("location", "upstairs")] }),

  // ── Other roles (owner ruling 3: same policy, no automatic route) ───────
  send("O-R1", "owner-ruling-2026-10-01 (vendor)", "Ask Ahmed to come and fix the kitchen sink tomorrow.", "tracked", "Ahmed",
    [R("Ahmed fixes the kitchen sink tomorrow", OP)], [], { critical: true, anchors: [A("date", "tomorrow"), A("location", "sink")] }),
  send("O-R2", "owner-ruling-2026-10-01 (vendor)", "Tell Ahmed the gate code is 4471.", "direct", "Ahmed", [R("the gate code is 4471", INFO)], [], { critical: true, anchors: [A("quantity", "4471")] }),
  send("O-R3", "owner-ruling-2026-10-01 (friend)", "Tell Dana I'd love to have her over for dinner on Friday.", "direct", "Dana",
    [R("Sana would love to have Dana over for dinner on Friday (invitation)", PM)], [], { critical: true, anchors: [A("date", "friday")] }),

  // ── V1/V2 corpus carried forward (labels restated for V3) ───────────────
  send("V-L1", "v1:L1", "Bro, ask Christopher if he can please prepare some lunch for me, and tell Grace when it's ready, and you keep an eye on it until he confirms.", "tracked", "Christopher",
    [R("Christopher prepares lunch for Sana", OP), R("Christopher tells Grace when it is ready", OP)], [CUSTODY],
    { anchors: [A("person", "Grace")], forbidden: ["keep an eye", "until he confirms", "track"] }),
  send("V-L2", "v1:L2", "Ask Christopher to prepare lunch and tell Grace it is ready.", "tracked", "Christopher",
    [R("Christopher prepares lunch", OP), R("Christopher tells Grace it is ready", OP)], [], { anchors: [A("person", "Grace")] }),
  send("V-L3", "v1:L3", "Ask Christopher to prepare lunch and track this until he confirms.", "tracked", "Christopher", [R("Christopher prepares lunch", OP)], [CUSTODY], { forbidden: ["track", "until he confirms"] }),
  send("V-R1", "v1:R1", "Ask Christopher to collect the package and put it in my room.", "tracked", "Christopher",
    [R("Christopher collects the package", OP), R("Christopher puts it in Sana's room", OP)], [], { anchors: [A("location", "room")] }),
  send("V-R2", "v1:R2", "Ask Christopher to follow up with the butcher and let me know what he says.", "tracked", "Christopher",
    [R("Christopher follows up with the butcher", OP), R("what the butcher says reaches Sana", OP, REPORT)], [], { anchors: [A("person", "butcher")] }),
  send("V-R3", "v1:R3", "Ask Christopher to book the restaurant and let me know the time.", "tracked", "Christopher",
    [R("Christopher books the restaurant", OP), R("the booking time reaches Sana", OP, REPORT)], [], { anchors: [A("location", "restaurant")] }),
  send("V-R4", "v1:R4", "Track this for me: ask Christopher to prepare lunch.", "tracked", "Christopher", [R("Christopher prepares lunch", OP)], [CUSTODY], { forbidden: ["track"] }),
  hold("V-R5", "v1:R5", "Ask Christopher to prepare lunch, and once he confirms, remind me to call Grace.", "tracked", "Christopher",
    [R("Christopher prepares lunch", OP)], [["remind_owner", "act_on_condition"]], { forbidden: ["remind", "call grace"] }),
  send("V-R10", "v1:R10", "Ask Christopher to call the butcher and tell me what he says.", "tracked", "Christopher",
    [R("Christopher calls the butcher", OP), R("Christopher tells Sana what the butcher says (recipient's own work)", OP)], [], { anchors: [A("person", "butcher")] }),
  send("V-R11", "v1:R11", "Ask Christopher to check the delivery and call the driver if it is late.", "tracked", "Christopher",
    [R("Christopher checks the delivery", OP), R("if it is late, Christopher calls the driver", OP)], [], { anchors: [A("condition", "late"), A("person", "driver")] }),
  send("V-S1", "v1:S1", "Ask Ghulam to water the garden.", "tracked", "Ghulam", [R("Ghulam waters the garden", OP)]),
  send("V-S2", "v1:S2", "Have Nasira bake a cake for tonight.", "tracked", "Nasira", [R("Nasira bakes a cake for tonight", OP)], [], { anchors: [A("date", "tonight")] }),
  send("V-S3", "v1:S3", "Ask Grace to change the bedsheets, vacuum the guest room and restock the towels.", "tracked", "Grace",
    [R("Grace changes the bedsheets", OP), R("Grace vacuums the guest room", OP), R("Grace restocks the towels", OP)], [], { anchors: [A("location", "guest room")] }),
  send("V-S4", "v1:S4", "Ask Christopher to wash the car and fill up the tank.", "tracked", "Christopher", [R("Christopher washes the car", OP), R("Christopher fills up the tank", OP)]),
  send("V-S5", "v1:S5", "Ask Grace to count the silverware and send me the number.", "tracked", "Grace", [R("Grace counts the silverware", OP), R("Grace sends Sana the number", OP)]),
  send("V-S6", "v1:S6", "Ask Ghulam to check the sprinklers and tell me which ones are broken.", "tracked", "Ghulam", [R("Ghulam checks the sprinklers", OP), R("Ghulam tells Sana which are broken", OP)]),
  send("V-S7", "v1:S7", "Ask Nasira to call the fishmonger and order two kilos of prawns.", "tracked", "Nasira",
    [R("Nasira calls the fishmonger", OP), R("Nasira orders two kilos of prawns", OP)], [], { anchors: [A("quantity", "2", "two")] }),
  send("V-S8", "v1:S8", "Ask Christopher to pick up Loulya from school and tell her teacher she has a dentist appointment.", "tracked", "Christopher",
    [R("Christopher picks up Loulya from school", OP), R("Christopher tells her teacher she has a dentist appointment", OP)], [], { anchors: [A("person", "Loulya"), A("location", "school")] }),
  send("V-S9", "v1:S9", "Ask Ghulam to cover the plants if it rains.", "tracked", "Ghulam", [R("if it rains, Ghulam covers the plants", OP)], [], { anchors: [A("condition", "rain")] }),
  send("V-S10", "v1:S10", "Ask Christopher to buy milk, and if the shop is closed, try the one near the mosque.", "tracked", "Christopher",
    [R("Christopher buys milk", OP), R("if the shop is closed, he tries the one near the mosque", OP)], [], { anchors: [A("condition", "closed"), A("location", "mosque")] }),
  send("V-S11", "v1:S11", "Ask Grace to set the table before 7 and light the candles at 7:30.", "tracked", "Grace",
    [R("Grace sets the table before 7", OP), R("Grace lights the candles at 7:30", OP)], [], { anchors: [A("time", "7:30", "seven thirty", "half past seven")] }),
  send("V-S13", "v1:S13", "Ask Christopher to take the dog to the vet and bring him back before lunch.", "tracked", "Christopher",
    [R("Christopher takes the dog to the vet", OP), R("Christopher brings the dog back before lunch", OP)], [], { anchors: [A("time", "before lunch")] }),
  send("V-S14", "v1:S14", "Ask Grace to fix the lamp in my room, it keeps flickering.", "tracked", "Grace", [R("Grace fixes the lamp in Sana's room", OP)], [], { anchors: [A("location", "room")] }),
  send("V-S15", "v1:S15", "ask christopher to prepare lunch - and tell grace it's ready", "tracked", "Christopher",
    [R("Christopher prepares lunch", OP), R("Christopher tells Grace it is ready", OP)], [], { anchors: [A("person", "Grace")] }),
  send("V-S16", "v1:S16", "Ask Christopher: prepare lunch; then tell Grace it's ready.", "tracked", "Christopher",
    [R("Christopher prepares lunch", OP), R("then Christopher tells Grace it is ready", OP)], [], { anchors: [A("person", "Grace")] }),
  send("V-S17", "v1:S17", "uh ask Christopher to um get the groceries and uh put them away", "tracked", "Christopher", [R("Christopher gets the groceries", OP), R("Christopher puts them away", OP)]),
  send("V-S18", "v1:S18", "Christopher... prepare lunch... and tell Grace when it's ready, okay?", "tracked", "Christopher",
    [R("Christopher prepares lunch", OP), R("Christopher tells Grace when it is ready", OP)], [], { anchors: [A("person", "Grace")] }),
  send("V-S19", "v1:S19", "Keep an eye on this: ask Ghulam to trim the hedges.", "tracked", "Ghulam", [R("Ghulam trims the hedges", OP)], [CUSTODY], { forbidden: ["keep an eye"] }),
  send("V-S20", "v1:S20", "Make sure this gets tracked — ask Christopher to prepare lunch.", "tracked", "Christopher", [R("Christopher prepares lunch", OP)], [CUSTODY], { forbidden: ["tracked", "make sure this"] }),
  send("V-S21", "v1:S21", "Ask Nasira to make soup and follow up with her if she doesn't reply.", "tracked", "Nasira", [R("Nasira makes soup", OP)], [CUSTODY], { forbidden: ["follow up with her"] }),
  send("V-S22", "v1:S22", "Ask Grace to clean the kitchen and keep me posted on whether she did it.", "tracked", "Grace",
    [R("Grace cleans the kitchen", OP), R("whether she did it reaches Sana", OP, REPORT)], [], { anchors: [A("location", "kitchen")] }),
  hold("V-S23", "v1:S23", "Ask Ghulam to fix the gate and remind me tomorrow to check it.", "tracked", "Ghulam", [R("Ghulam fixes the gate", OP)], [["remind_owner"]], { forbidden: ["remind"] }),
  send("V-S24", "v1:S24", "Ask Christopher to wash the car and tell Grace it's done, and chase him if he doesn't answer.", "tracked", "Christopher",
    [R("Christopher washes the car", OP), R("Christopher tells Grace it is done", OP)], [CUSTODY], { anchors: [A("person", "Grace")], forbidden: ["chase"] }),
  send("V-N1", "v1:N1", "Hey Carson, so, um, when you get a sec could you ask Grace to change the sheets in the guest room, we've got people coming tomorrow, thanks.", "tracked", "Grace",
    [R("Grace changes the sheets in the guest room", OP), R("people are coming tomorrow", INFO)], [], { anchors: [A("location", "guest room"), A("date", "tomorrow")] }),
  send("V-N2", "v1:N2", "Okay so Christopher needs to pick up the dry cleaning at like 5, can you ask him, and make sure he actually does it.", "tracked", "Christopher",
    [R("Christopher picks up the dry cleaning at about 5", OP)], [CUSTODY], { anchors: [A("time", "5", "five")], forbidden: ["make sure he", "actually does"] }),
  send("V-N3", "v1:N3", "Carson can you just let Nasira know the guests are now coming at 8 instead of 7.", "direct", "Nasira",
    [R("the guests are now coming at 8 instead of 7", INFO)], [], { anchors: [A("time", "8", "eight"), A("time", "7", "seven")] }),
  send("V-N4", "v1:N4", "ya Carson tell Ghulam the gate code changed to 4471, he needs it tonight", "direct", "Ghulam",
    [R("the gate code changed to 4471; he needs it tonight", INFO)], [], { anchors: [A("quantity", "4471"), A("date", "tonight")] }),
  send("V-N5", "v1:N5", "Umm ask Grace, if she has time today, to iron the white shirts, like three of them, and then hang them in my closet.", "tracked", "Grace",
    [R("if she has time today, Grace irons about three white shirts", OP), R("then hangs them in Sana's closet", OP)], [],
    { anchors: [A("quantity", "3", "three"), A("date", "today"), A("condition", "time"), A("location", "closet")] }),
  send("V-N6", "v1:N6", "Could you get Nasira to grab 2 kilos of lamb from the butcher on Salwa Road, for the weekend basically.", "tracked", "Nasira",
    [R("Nasira buys 2 kilos of lamb from the butcher on Salwa Road, for the weekend", OP)], [], { anchors: [A("quantity", "2", "two"), A("location", "salwa"), A("date", "weekend")] }),
  send("V-N7", "v1:N7", "Tell Grace the plumber is coming Thursday at 10.", "direct", "Grace", [R("the plumber is coming Thursday at 10", INFO)], [],
    { anchors: [A("date", "thursday"), A("time", "10", "ten")] }),
  send("V-N8", "v1:N8", "So listen, I need Ghulam to take the Range Rover to the car wash, and, you know, check the tyre pressure while he's there, and tell me if anything looks off.", "tracked", "Ghulam",
    [R("Ghulam takes the Range Rover to the car wash", OP), R("Ghulam checks the tyre pressure there", OP), R("Ghulam tells Sana if anything looks off", OP, REPORT)], [],
    { anchors: [A("location", "car wash")] }),
  hold("V-U1", "v1:U1", "Tell Grace dinner is at eight and remind me at seven to get changed.", "direct", "Grace", [R("dinner is at eight", INFO)], [["remind_owner"]], { forbidden: ["remind", "get changed"] }),
  hold("V-U3", "v1:U3", "Ask Christopher to buy flowers, and if he can't, ask Ghulam instead.", "tracked", "Christopher", [R("Christopher buys flowers", OP)], [["contact_other_person", "act_on_condition"]]),
  { id: "V-A1", source: "v1:A1", lang: "en", compound: false, critical: false, u: "Ask him to prepare lunch.", expected: { outcome: "CLARIFY", reason: "recipient_unknown" }, anchors: [], forbidden: [] },
  {
    id: "V-A2", source: "v1:A2", lang: "en", compound: false, critical: false, u: "Ask Christopher to handle it.",
    expected: { outcome: "SEND_OR_CLARIFY", route: "tracked", recipient: "Christopher", responsibilities: [R("Christopher handles it (nothing invented about what 'it' is)", OP)], instructions: [], clarifyReason: "responsibility_unclear" },
    anchors: [], forbidden: [],
  },
  {
    id: "V-A3", source: "v1:A3", lang: "en", compound: true, critical: false, u: "Ask Christopher to sort out the thing with the car and let me know.",
    expected: { outcome: "SEND_OR_CLARIFY", route: "tracked", recipient: "Christopher", responsibilities: [R("Christopher sorts out the thing with the car", OP), R("the outcome reaches Sana", OP, REPORT)], instructions: [], clarifyReason: "responsibility_unclear" },
    anchors: [], forbidden: [],
  },
  { id: "V-A4", source: "v1:A4", lang: "en", compound: false, critical: false, u: "Ask Maria to water the plants.", expected: { outcome: "CLARIFY", reason: "recipient_unknown" }, anchors: [], forbidden: [] },

  // ── Arabic ──────────────────────────────────────────────────────────────
  send("V-AR1", "v1:AR1", "اطلب من كريستوفر أن يحضر الغداء ويخبر غريس أنه جاهز.", "tracked", "Christopher",
    [R("Christopher prepares lunch", OP), R("Christopher tells Grace it is ready", OP)], [], { lang: "ar", anchors: [A("person", "غريس", "grace")] }),
  send("V-AR2", "v1:AR2", "قل لغريس إن العشاء الساعة الثامنة.", "direct", "Grace", [R("dinner is at eight", INFO)], [], { lang: "ar", critical: true, anchors: [A("time", "الثامن", "8", "ثمان", "eight")] }),
  send("V-AR3", "v1:AR3", "اطلب من كريستوفر أن يغسل السيارة وتابع معه حتى يؤكد.", "tracked", "Christopher", [R("Christopher washes the car", OP)], [CUSTODY],
    { lang: "ar", forbidden: ["تابع", "حتى يؤكد", "track"] }),
  send("V-AR4", "v1:AR4", "كارسون قول لكريستوفر يجهز الغدا ويقول لغريس إذا خلص", "tracked", "Christopher",
    [R("Christopher prepares lunch", OP), R("Christopher tells Grace when it is done", OP)], [], { lang: "ar", anchors: [A("person", "غريس", "grace")] }),
  send("V-AR5", "v1:AR5", "قول لغلام إن الضيوف جايين الساعة سبعة", "direct", "Ghulam", [R("the guests are coming at seven", INFO)], [], { lang: "ar", critical: true, anchors: [A("time", "سبع", "7", "seven")] }),
  send("V-AR6", "v1:AR6", "اطلب من نصيرة تشتري كيلوين لحم من الجزار بكرة الصبح", "tracked", "Nasira",
    [R("Nasira buys two kilos of meat from the butcher tomorrow morning", OP)], [], { lang: "ar", anchors: [A("quantity", "كيلوين", "2", "two", "اثنين"), A("date", "بكره", "بكرا", "tomorrow"), A("time", "الصبح", "morning", "صباح")] }),
  send("V-AR7", "v1:AR7", "خل غريس تتصل فيني", "tracked", "Grace", [R("Grace calls Sana (staff asked to call the owner)", OP)], [], { lang: "ar", critical: true }),
  send("V-AR8", "v1:AR8", "اطلب من كريستوفر يحضر الغدا وتابع الموضوع لين يأكد", "tracked", "Christopher", [R("Christopher prepares lunch", OP)], [CUSTODY],
    { lang: "ar", forbidden: ["تابع", "لين يأكد", "track"] }),
  send("V-AR9", "v2:AR9", "قول للوليا إني أبغاها تتصل فيني", "direct", "Loulya", [R("Sana would like Loulya to call her (family wish)", PM)], [], { lang: "ar", critical: true }),

  // ── Mixed Arabic/English ─────────────────────────────────────────────────
  send("V-M1", "v1:M1", "Ask Christopher to جيب الخبز and tell Grace it's here.", "tracked", "Christopher",
    [R("Christopher brings the bread", OP), R("Christopher tells Grace it is here", OP)], [], { lang: "mixed", anchors: [A("person", "grace", "غريس")] }),
  send("V-M2", "v1:M2", "اطلب من Christopher يغسل السيارة and track it until he confirms.", "tracked", "Christopher", [R("Christopher washes the car", OP)], [CUSTODY],
    { lang: "mixed", forbidden: ["track", "until he confirms"] }),
  send("V-M3", "v1:M3", "Tell Grace إن العشاء at eight.", "direct", "Grace", [R("dinner is at eight", INFO)], [], { lang: "mixed", critical: true, anchors: [A("time", "8", "eight", "ثمان")] }),
  send("V-M4", "v1:M4", "Ask Ghulam يغسل السيارة before 5 and tell me when it's done.", "tracked", "Ghulam",
    [R("Ghulam washes the car before 5", OP), R("that it is done reaches Sana", OP, REPORT)], [], { lang: "mixed", anchors: [A("time", "5", "five", "خمس")] }),
];

/** Kept OUTSIDE the V3 acceptance set, unresolved. Not solved here. */
export const V3_EXCLUSIONS = [
  { id: "S12", u: "Tomorrow morning, ask Christopher to take the car for service.", reason: "timing ambiguity: send tomorrow vs work tomorrow (unresolved)" },
  { id: "U2", u: "Ask Christopher to book the restaurant for Friday and put it in my calendar.", reason: "calendar side-action ownership (unresolved)" },
  { id: "A5", u: "Ask Christopher and Grace to set up the terrace for tonight.", reason: "multiple recipients (unresolved)" },
  { id: "WISH-STAFF", u: "Tell Grace I need her to call me.", reason: "staff wish-shaped request (unresolved)" },
] as const;
