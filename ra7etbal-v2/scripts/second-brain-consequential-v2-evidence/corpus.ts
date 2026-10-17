/**
 * EVIDENCE ONLY — frozen V2 truth set. FROZEN BEFORE ANY MODEL RUN.
 *
 * Every expectation comes from the owner-approved C-02 ruling on Main
 * (RA7ETBAL_STATE.md, "C-02 — Accountability determines routing", 2026-09-30),
 * the protected C-02 examples, the v1 corpus, and the cases approved for V2.
 * Nothing here is derived from model output. Do not edit after model runs.
 *
 * Responsibilities are frozen as MEANING (plain language) plus the expected
 * answer to "after truthful delivery, does Carson still own follow-through?".
 * The model may phrase, split or merge items differently; hand review judges
 * meaning. Anchors and `forbidden` are evaluation-only flags, never runtime.
 */
import type { FrozenAnchor, Person } from "./anchors";
import type { CarsonDutyType, ClarificationReason } from "./skill";
import type { Route } from "./plan";

export const OWNER_NAME = "Sana"; // authoritative display name; used verbatim in every language (recorded data assumption)

export const OWNER_PEOPLE: Person[] = [
  { name: "Christopher", aliases: ["christopher", "كريستوفر"], relationship: "staff" },
  { name: "Grace", aliases: ["grace", "غريس", "جريس"], relationship: "staff" },
  { name: "Ghulam", aliases: ["ghulam", "غلام"], relationship: "staff" },
  { name: "Nasira", aliases: ["nasira", "نصيرة", "نصيره"], relationship: "staff" },
  { name: "Loulya", aliases: ["loulya", "لوليا"], relationship: "family" },
];
/** Belongs to a different owner (tenant-isolation fixture). */
export const OTHER_OWNER_PEOPLE: Person[] = [{ name: "Maria", aliases: ["maria", "ماريا"], relationship: "staff" }];

export type Lang = "en" | "ar" | "mixed";

export interface ExpectedResponsibility {
  meaning: string;
  carsonFollowsThrough: boolean;
  /** Also satisfied if the owner-facing part is carried by this Carson duty instead of an item. */
  orCarsonDuty?: CarsonDutyType;
}

export type Expected =
  | { outcome: "SEND"; route: Route; recipient: string; responsibilities: ExpectedResponsibility[]; duties: CarsonDutyType[][] }
  | { outcome: "HOLD"; route: Route; recipient: string; responsibilities: ExpectedResponsibility[]; duties: CarsonDutyType[][] }
  | { outcome: "CLARIFY"; reason: ClarificationReason }
  | {
      outcome: "SEND_OR_CLARIFY";
      route: Route;
      recipient: string;
      responsibilities: ExpectedResponsibility[];
      duties: CarsonDutyType[][];
      clarifyReason: ClarificationReason;
    };

export interface V2Case {
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

const R = (meaning: string, carsonFollowsThrough: boolean, orCarsonDuty?: CarsonDutyType): ExpectedResponsibility =>
  orCarsonDuty ? { meaning, carsonFollowsThrough, orCarsonDuty } : { meaning, carsonFollowsThrough };
const A = (type: FrozenAnchor["type"], ...any: string[]): FrozenAnchor => ({ type, any });
const TRACK: CarsonDutyType[] = ["track_until_confirmed", "report_outcome_to_owner"];

type Opt = { anchors?: FrozenAnchor[]; forbidden?: string[]; critical?: boolean; compound?: boolean; lang?: Lang };
function send(id: string, source: string, u: string, route: Route, recipient: string, responsibilities: ExpectedResponsibility[], duties: CarsonDutyType[][], o: Opt = {}): V2Case {
  return {
    id, source, u, lang: o.lang ?? "en", critical: o.critical ?? false, compound: o.compound ?? responsibilities.length > 1,
    expected: { outcome: "SEND", route, recipient, responsibilities, duties }, anchors: o.anchors ?? [], forbidden: o.forbidden ?? [],
  };
}
function hold(id: string, source: string, u: string, route: Route, recipient: string, responsibilities: ExpectedResponsibility[], duties: CarsonDutyType[][], o: Opt = {}): V2Case {
  return {
    id, source, u, lang: o.lang ?? "en", critical: o.critical ?? false, compound: true,
    expected: { outcome: "HOLD", route, recipient, responsibilities, duties }, anchors: o.anchors ?? [], forbidden: o.forbidden ?? [],
  };
}

export const V2_CASES: V2Case[] = [
  // ── Authoritative C-02 (owner ruling 2026-09-30) — critical ─────────────
  send("A-T1", "authoritative-c02", "Ask Grace to call me.", "tracked", "Grace", [R("Grace calls Sana", true)], [], { critical: true }),
  send("A-T2", "authoritative-c02", "Tell Grace to call me.", "tracked", "Grace", [R("Grace calls Sana", true)], [], { critical: true }),
  send("A-T3", "authoritative-c02", "Ask Grace to call me now.", "tracked", "Grace", [R("Grace calls Sana now", true)], [], { critical: true, anchors: [A("time", "now", "right away", "immediately")] }),
  send("A-T4", "authoritative-c02", "Ask Grace to call me from the office.", "tracked", "Grace", [R("Grace calls Sana from the office", true)], [], { critical: true, anchors: [A("location", "office")] }),
  send("A-T5", "authoritative-c02", "Tell Grace to arrange the guest room.", "tracked", "Grace", [R("Grace arranges the guest room", true)], [], { critical: true, anchors: [A("location", "guest room")] }),
  send("A-T6", "authoritative-c02", "Ask Christopher to bring the car around at 6.", "tracked", "Christopher", [R("Christopher brings the car around at 6", true)], [], { critical: true, anchors: [A("time", "6", "six")] }),
  send("A-T7", "authoritative-c02", "Ask Christopher to make pizza.", "tracked", "Christopher", [R("Christopher makes pizza", true)], [], { critical: true }),
  send("A-T8", "authoritative-c02", "Ask Christopher to clean the kitchen.", "tracked", "Christopher", [R("Christopher cleans the kitchen", true)], [], { critical: true, anchors: [A("location", "kitchen")] }),
  send("A-D1", "authoritative-c02", "Tell Loulya I would like her to call me.", "direct", "Loulya", [R("Sana would like Loulya to call her (a personal wish)", false)], [], { critical: true }),
  send("A-D2", "authoritative-c02", "Tell Christopher dinner is at eight.", "direct", "Christopher", [R("dinner is at eight (information)", false)], [], { critical: true, anchors: [A("time", "8", "eight")] }),
  send("A-D3", "authoritative-c02", "Ask Christopher to meet me outside.", "direct", "Christopher", [R("Christopher meets Sana outside (presence Sana witnesses)", false)], [], { critical: true, anchors: [A("location", "outside")] }),
  send("A-D4", "authoritative-c02", "Tell Christopher to wait for me in the kitchen.", "direct", "Christopher", [R("Christopher waits for Sana in the kitchen (presence)", false)], [], { critical: true, anchors: [A("location", "kitchen")] }),
  send("A-X1", "authoritative-c02 (explicit custody)", "Tell Loulya I would like her to call me, and make sure she does.", "tracked", "Loulya", [R("Sana would like Loulya to call her", false)], [TRACK], { critical: true, forbidden: ["make sure she", "make sure you"] }),
  send("A-C1", "authoritative-c02 (compound)", "Ask Christopher to prepare lunch and tell Grace it is ready, and track this until he confirms.", "tracked", "Christopher",
    [R("Christopher prepares lunch", true), R("Christopher tells Grace when it is ready", true)], [["track_until_confirmed"]],
    { critical: true, anchors: [A("person", "Grace")], forbidden: ["track", "until he confirms", "until you confirm"] }),

  // ── Protected C-02 examples (carson-protected-behaviors.test.ts) — critical ─
  send("P-1", "protected", "Ask Christopher to prepare dinner at 7.", "tracked", "Christopher", [R("Christopher prepares dinner at 7", true)], [], { critical: true, anchors: [A("time", "7", "seven")] }),
  send("P-2", "protected", "Have Christopher buy milk.", "tracked", "Christopher", [R("Christopher buys milk", true)], [], { critical: true }),
  send("P-3", "protected", "Ask Ghulam to bring the car out.", "tracked", "Ghulam", [R("Ghulam brings the car out", true)], [], { critical: true }),
  send("P-4", "protected", "Ask Christopher to check whether the guest room is ready.", "tracked", "Christopher", [R("Christopher checks whether the guest room is ready", true)], [], { critical: true, anchors: [A("location", "guest room")] }),
  send("P-5", "protected", "Tell Ghulam to wait by the car for me.", "direct", "Ghulam", [R("Ghulam waits by the car for Sana (presence)", false)], [], { critical: true, anchors: [A("location", "car")] }),
  send("P-6", "protected", "Tell Nasira to wait until 8.", "direct", "Nasira", [R("Nasira waits until 8", false)], [], { critical: true, anchors: [A("time", "8", "eight")] }),
  send("P-7", "protected", "Christopher, come to the kitchen now.", "direct", "Christopher", [R("Christopher comes to the kitchen now (presence)", false)], [], { critical: true, anchors: [A("location", "kitchen"), A("time", "now", "right away")] }),
  send("P-8", "protected", "Tell Grace I'm running late.", "direct", "Grace", [R("Sana is running late (information)", false)], [], { critical: true }),
  send("P-9", "protected", "Tell Ghulam I'm on my way.", "direct", "Ghulam", [R("Sana is on her way (information)", false)], [], { critical: true }),
  send("P-10", "protected", "Tell Christopher to meet me outside.", "direct", "Christopher", [R("Christopher meets Sana outside (presence)", false)], [], { critical: true, anchors: [A("location", "outside")] }),

  // ── v1 corpus carried forward (labels restated for the V2 contract) ─────
  send("V1-L1", "v1:L1", "Bro, ask Christopher if he can please prepare some lunch for me, and tell Grace when it's ready, and you keep an eye on it until he confirms.", "tracked", "Christopher",
    [R("Christopher prepares lunch for Sana", true), R("Christopher tells Grace when it is ready", true)], [["track_until_confirmed"]],
    { anchors: [A("person", "Grace")], forbidden: ["keep an eye", "until he confirms", "track"] }),
  send("V1-L2", "v1:L2", "Ask Christopher to prepare lunch and tell Grace it is ready.", "tracked", "Christopher",
    [R("Christopher prepares lunch", true), R("Christopher tells Grace it is ready", true)], [], { anchors: [A("person", "Grace")] }),
  send("V1-L3", "v1:L3", "Ask Christopher to prepare lunch and track this until he confirms.", "tracked", "Christopher", [R("Christopher prepares lunch", true)], [["track_until_confirmed"]], { forbidden: ["track", "until he confirms"] }),
  send("V1-R1", "v1:R1", "Ask Christopher to collect the package and put it in my room.", "tracked", "Christopher",
    [R("Christopher collects the package", true), R("Christopher puts it in Sana's room", true)], [], { anchors: [A("location", "room")] }),
  send("V1-R2", "v1:R2", "Ask Christopher to follow up with the butcher and let me know what he says.", "tracked", "Christopher",
    [R("Christopher follows up with the butcher", true), R("what the butcher says reaches Sana", true, "report_outcome_to_owner")], [], { anchors: [A("person", "butcher")] }),
  send("V1-R3", "v1:R3", "Ask Christopher to book the restaurant and let me know the time.", "tracked", "Christopher",
    [R("Christopher books the restaurant", true), R("the booking time reaches Sana", true, "report_outcome_to_owner")], [], { anchors: [A("location", "restaurant")] }),
  send("V1-R4", "v1:R4", "Track this for me: ask Christopher to prepare lunch.", "tracked", "Christopher", [R("Christopher prepares lunch", true)], [["track_until_confirmed"]], { forbidden: ["track"] }),
  hold("V1-R5", "v1:R5", "Ask Christopher to prepare lunch, and once he confirms, remind me to call Grace.", "tracked", "Christopher",
    [R("Christopher prepares lunch", true)], [["remind_owner", "act_on_condition"]], { forbidden: ["remind", "call grace"] }),
  // v1:R9 is word-for-word the authoritative compound case A-C1; not duplicated.
  send("V1-R10", "v1:R10", "Ask Christopher to call the butcher and tell me what he says.", "tracked", "Christopher",
    [R("Christopher calls the butcher", true), R("Christopher tells Sana what the butcher says (recipient's own work)", true)], [], { anchors: [A("person", "butcher")] }),
  send("V1-R11", "v1:R11", "Ask Christopher to check the delivery and call the driver if it is late.", "tracked", "Christopher",
    [R("Christopher checks the delivery", true), R("if it is late, Christopher calls the driver", true)], [], { anchors: [A("condition", "late"), A("person", "driver")] }),
  send("V1-S1", "v1:S1", "Ask Ghulam to water the garden.", "tracked", "Ghulam", [R("Ghulam waters the garden", true)], []),
  send("V1-S2", "v1:S2", "Have Nasira bake a cake for tonight.", "tracked", "Nasira", [R("Nasira bakes a cake for tonight", true)], [], { anchors: [A("date", "tonight")] }),
  send("V1-S3", "v1:S3", "Ask Grace to change the bedsheets, vacuum the guest room and restock the towels.", "tracked", "Grace",
    [R("Grace changes the bedsheets", true), R("Grace vacuums the guest room", true), R("Grace restocks the towels", true)], [], { anchors: [A("location", "guest room")] }),
  send("V1-S4", "v1:S4", "Ask Christopher to wash the car and fill up the tank.", "tracked", "Christopher", [R("Christopher washes the car", true), R("Christopher fills up the tank", true)], []),
  send("V1-S5", "v1:S5", "Ask Grace to count the silverware and send me the number.", "tracked", "Grace", [R("Grace counts the silverware", true), R("Grace sends Sana the number", true)], []),
  send("V1-S6", "v1:S6", "Ask Ghulam to check the sprinklers and tell me which ones are broken.", "tracked", "Ghulam", [R("Ghulam checks the sprinklers", true), R("Ghulam tells Sana which are broken", true)], []),
  send("V1-S7", "v1:S7", "Ask Nasira to call the fishmonger and order two kilos of prawns.", "tracked", "Nasira",
    [R("Nasira calls the fishmonger", true), R("Nasira orders two kilos of prawns", true)], [], { anchors: [A("quantity", "2", "two")] }),
  send("V1-S8", "v1:S8", "Ask Christopher to pick up Loulya from school and tell her teacher she has a dentist appointment.", "tracked", "Christopher",
    [R("Christopher picks up Loulya from school", true), R("Christopher tells her teacher she has a dentist appointment", true)], [], { anchors: [A("person", "Loulya"), A("location", "school")] }),
  send("V1-S9", "v1:S9", "Ask Ghulam to cover the plants if it rains.", "tracked", "Ghulam", [R("if it rains, Ghulam covers the plants", true)], [], { anchors: [A("condition", "rain")] }),
  send("V1-S10", "v1:S10", "Ask Christopher to buy milk, and if the shop is closed, try the one near the mosque.", "tracked", "Christopher",
    [R("Christopher buys milk", true), R("if the shop is closed, he tries the one near the mosque", true)], [], { anchors: [A("condition", "closed"), A("location", "mosque")] }),
  send("V1-S11", "v1:S11", "Ask Grace to set the table before 7 and light the candles at 7:30.", "tracked", "Grace",
    [R("Grace sets the table before 7", true), R("Grace lights the candles at 7:30", true)], [], { anchors: [A("time", "7:30", "seven thirty", "half past seven")] }),
  send("V1-S13", "v1:S13", "Ask Christopher to take the dog to the vet and bring him back before lunch.", "tracked", "Christopher",
    [R("Christopher takes the dog to the vet", true), R("Christopher brings the dog back before lunch", true)], [], { anchors: [A("time", "before lunch")] }),
  send("V1-S14", "v1:S14", "Ask Grace to fix the lamp in my room, it keeps flickering.", "tracked", "Grace", [R("Grace fixes the lamp in Sana's room", true)], [], { anchors: [A("location", "room")] }),
  send("V1-S15", "v1:S15", "ask christopher to prepare lunch - and tell grace it's ready", "tracked", "Christopher",
    [R("Christopher prepares lunch", true), R("Christopher tells Grace it is ready", true)], [], { anchors: [A("person", "Grace")] }),
  send("V1-S16", "v1:S16", "Ask Christopher: prepare lunch; then tell Grace it's ready.", "tracked", "Christopher",
    [R("Christopher prepares lunch", true), R("then Christopher tells Grace it is ready", true)], [], { anchors: [A("person", "Grace")] }),
  send("V1-S17", "v1:S17", "uh ask Christopher to um get the groceries and uh put them away", "tracked", "Christopher", [R("Christopher gets the groceries", true), R("Christopher puts them away", true)], []),
  send("V1-S18", "v1:S18", "Christopher... prepare lunch... and tell Grace when it's ready, okay?", "tracked", "Christopher",
    [R("Christopher prepares lunch", true), R("Christopher tells Grace when it is ready", true)], [], { anchors: [A("person", "Grace")] }),
  send("V1-S19", "v1:S19", "Keep an eye on this: ask Ghulam to trim the hedges.", "tracked", "Ghulam", [R("Ghulam trims the hedges", true)], [["track_until_confirmed"]], { forbidden: ["keep an eye"] }),
  send("V1-S20", "v1:S20", "Make sure this gets tracked — ask Christopher to prepare lunch.", "tracked", "Christopher", [R("Christopher prepares lunch", true)], [["track_until_confirmed"]], { forbidden: ["tracked", "make sure this"] }),
  send("V1-S21", "v1:S21", "Ask Nasira to make soup and follow up with her if she doesn't reply.", "tracked", "Nasira", [R("Nasira makes soup", true)], [["track_until_confirmed"]], { forbidden: ["follow up with her"] }),
  send("V1-S22", "v1:S22", "Ask Grace to clean the kitchen and keep me posted on whether she did it.", "tracked", "Grace",
    [R("Grace cleans the kitchen", true), R("whether she did it reaches Sana", true, "report_outcome_to_owner")], [], { anchors: [A("location", "kitchen")] }),
  hold("V1-S23", "v1:S23", "Ask Ghulam to fix the gate and remind me tomorrow to check it.", "tracked", "Ghulam", [R("Ghulam fixes the gate", true)], [["remind_owner"]], { forbidden: ["remind"] }),
  send("V1-S24", "v1:S24", "Ask Christopher to wash the car and tell Grace it's done, and chase him if he doesn't answer.", "tracked", "Christopher",
    [R("Christopher washes the car", true), R("Christopher tells Grace it is done", true)], [["track_until_confirmed"]], { anchors: [A("person", "Grace")], forbidden: ["chase"] }),
  send("V1-N1", "v1:N1", "Hey Carson, so, um, when you get a sec could you ask Grace to change the sheets in the guest room, we've got people coming tomorrow, thanks.", "tracked", "Grace",
    [R("Grace changes the sheets in the guest room", true), R("people are coming tomorrow (information)", false)], [], { anchors: [A("location", "guest room"), A("date", "tomorrow")] }),
  send("V1-N2", "v1:N2", "Okay so Christopher needs to pick up the dry cleaning at like 5, can you ask him, and make sure he actually does it.", "tracked", "Christopher",
    [R("Christopher picks up the dry cleaning at about 5", true)], [["track_until_confirmed"]], { anchors: [A("time", "5", "five")], forbidden: ["make sure he", "actually does"] }),
  send("V1-N3", "v1:N3", "Carson can you just let Nasira know the guests are now coming at 8 instead of 7.", "direct", "Nasira",
    [R("the guests are now coming at 8 instead of 7 (information)", false)], [], { anchors: [A("time", "8", "eight"), A("time", "7", "seven")] }),
  send("V1-N4", "v1:N4", "ya Carson tell Ghulam the gate code changed to 4471, he needs it tonight", "direct", "Ghulam",
    [R("the gate code changed to 4471; he needs it tonight (information)", false)], [], { anchors: [A("quantity", "4471"), A("date", "tonight")] }),
  send("V1-N5", "v1:N5", "Umm ask Grace, if she has time today, to iron the white shirts, like three of them, and then hang them in my closet.", "tracked", "Grace",
    [R("if she has time today, Grace irons about three white shirts", true), R("then hangs them in Sana's closet", true)], [],
    { anchors: [A("quantity", "3", "three"), A("date", "today"), A("condition", "time"), A("location", "closet")] }),
  send("V1-N6", "v1:N6", "Could you get Nasira to grab 2 kilos of lamb from the butcher on Salwa Road, for the weekend basically.", "tracked", "Nasira",
    [R("Nasira buys 2 kilos of lamb from the butcher on Salwa Road, for the weekend", true)], [], { anchors: [A("quantity", "2", "two"), A("location", "salwa"), A("date", "weekend")] }),
  send("V1-N7", "v1:N7", "Tell Grace the plumber is coming Thursday at 10.", "direct", "Grace", [R("the plumber is coming Thursday at 10 (information)", false)], [],
    { anchors: [A("date", "thursday"), A("time", "10", "ten")] }),
  send("V1-N8", "v1:N8", "So listen, I need Ghulam to take the Range Rover to the car wash, and, you know, check the tyre pressure while he's there, and tell me if anything looks off.", "tracked", "Ghulam",
    [R("Ghulam takes the Range Rover to the car wash", true), R("Ghulam checks the tyre pressure there", true), R("Ghulam tells Sana if anything looks off", true, "report_outcome_to_owner")], [],
    { anchors: [A("location", "car wash")] }),
  hold("V1-U1", "v1:U1", "Tell Grace dinner is at eight and remind me at seven to get changed.", "direct", "Grace", [R("dinner is at eight (information)", false)], [["remind_owner"]], { forbidden: ["remind", "get changed"] }),
  hold("V1-U3", "v1:U3", "Ask Christopher to buy flowers, and if he can't, ask Ghulam instead.", "tracked", "Christopher", [R("Christopher buys flowers", true)], [["contact_other_person", "act_on_condition"]]),
  { id: "V1-A1", source: "v1:A1", lang: "en", compound: false, critical: false, u: "Ask him to prepare lunch.", expected: { outcome: "CLARIFY", reason: "recipient_unknown" }, anchors: [], forbidden: [] },
  {
    id: "V1-A2", source: "v1:A2", lang: "en", compound: false, critical: false, u: "Ask Christopher to handle it.",
    expected: { outcome: "SEND_OR_CLARIFY", route: "tracked", recipient: "Christopher", responsibilities: [R("Christopher handles it (nothing invented about what 'it' is)", true)], duties: [], clarifyReason: "material_meaning_unclear" },
    anchors: [], forbidden: [],
  },
  {
    id: "V1-A3", source: "v1:A3", lang: "en", compound: true, critical: false, u: "Ask Christopher to sort out the thing with the car and let me know.",
    expected: { outcome: "SEND_OR_CLARIFY", route: "tracked", recipient: "Christopher", responsibilities: [R("Christopher sorts out the thing with the car", true), R("the outcome reaches Sana", true, "report_outcome_to_owner")], duties: [], clarifyReason: "material_meaning_unclear" },
    anchors: [], forbidden: [],
  },
  { id: "V1-A4", source: "v1:A4", lang: "en", compound: false, critical: false, u: "Ask Maria to water the plants.", expected: { outcome: "CLARIFY", reason: "recipient_unknown" }, anchors: [], forbidden: [] },

  // ── Arabic (v1 cases whose meaning is known) ─────────────────────────────
  send("V1-AR1", "v1:AR1", "اطلب من كريستوفر أن يحضر الغداء ويخبر غريس أنه جاهز.", "tracked", "Christopher",
    [R("Christopher prepares lunch", true), R("Christopher tells Grace it is ready", true)], [], { lang: "ar", anchors: [A("person", "غريس", "grace")] }),
  send("V1-AR2", "v1:AR2", "قل لغريس إن العشاء الساعة الثامنة.", "direct", "Grace", [R("dinner is at eight (information)", false)], [], { lang: "ar", critical: true, anchors: [A("time", "الثامن", "8", "ثمان", "eight")] }),
  send("V1-AR3", "v1:AR3", "اطلب من كريستوفر أن يغسل السيارة وتابع معه حتى يؤكد.", "tracked", "Christopher", [R("Christopher washes the car", true)], [["track_until_confirmed"]],
    { lang: "ar", forbidden: ["تابع", "حتى يؤكد", "track"] }),
  send("V1-AR4", "v1:AR4", "كارسون قول لكريستوفر يجهز الغدا ويقول لغريس إذا خلص", "tracked", "Christopher",
    [R("Christopher prepares lunch", true), R("Christopher tells Grace when it is done", true)], [], { lang: "ar", anchors: [A("person", "غريس", "grace")] }),
  send("V1-AR5", "v1:AR5", "قول لغلام إن الضيوف جايين الساعة سبعة", "direct", "Ghulam", [R("the guests are coming at seven (information)", false)], [], { lang: "ar", critical: true, anchors: [A("time", "سبع", "7", "seven")] }),
  send("V1-AR6", "v1:AR6", "اطلب من نصيرة تشتري كيلوين لحم من الجزار بكرة الصبح", "tracked", "Nasira",
    [R("Nasira buys two kilos of meat from the butcher tomorrow morning", true)], [], { lang: "ar", anchors: [A("quantity", "كيلوين", "2", "two", "اثنين"), A("date", "بكره", "بكرا", "tomorrow"), A("time", "الصبح", "morning", "صباح")] }),
  send("V1-AR7", "v1:AR7", "خل غريس تتصل فيني", "tracked", "Grace", [R("Grace calls Sana (staff owner-response: tracked)", true)], [], { lang: "ar", critical: true }),
  send("V1-AR8", "v1:AR8", "اطلب من كريستوفر يحضر الغدا وتابع الموضوع لين يأكد", "tracked", "Christopher", [R("Christopher prepares lunch", true)], [["track_until_confirmed"]],
    { lang: "ar", forbidden: ["تابع", "لين يأكد", "track"] }),
  send("V2-AR9", "v2-new", "قول للوليا إني أبغاها تتصل فيني", "direct", "Loulya", [R("Sana would like Loulya to call her (family wish)", false)], [], { lang: "ar", critical: true }),

  // ── Mixed Arabic/English ─────────────────────────────────────────────────
  send("V1-M1", "v1:M1", "Ask Christopher to جيب الخبز and tell Grace it's here.", "tracked", "Christopher",
    [R("Christopher brings the bread", true), R("Christopher tells Grace it is here", true)], [], { lang: "mixed", anchors: [A("person", "grace", "غريس")] }),
  send("V1-M2", "v1:M2", "اطلب من Christopher يغسل السيارة and track it until he confirms.", "tracked", "Christopher", [R("Christopher washes the car", true)], [["track_until_confirmed"]],
    { lang: "mixed", forbidden: ["track", "until he confirms"] }),
  send("V1-M3", "v1:M3", "Tell Grace إن العشاء at eight.", "direct", "Grace", [R("dinner is at eight (information)", false)], [], { lang: "mixed", critical: true, anchors: [A("time", "8", "eight", "ثمان")] }),
  send("V1-M4", "v1:M4", "Ask Ghulam يغسل السيارة before 5 and tell me when it's done.", "tracked", "Ghulam",
    [R("Ghulam washes the car before 5", true), R("that it is done reaches Sana", true, "report_outcome_to_owner")], [], { lang: "mixed", anchors: [A("time", "5", "five", "خمس")] }),
];

/** Kept OUTSIDE the V2 acceptance set, unresolved. Not solved here. */
export const V2_EXCLUSIONS = [
  { id: "S12", u: "Tomorrow morning, ask Christopher to take the car for service.", reason: "timing ambiguity: send tomorrow vs work tomorrow (product policy unresolved)" },
  { id: "U2", u: "Ask Christopher to book the restaurant for Friday and put it in my calendar.", reason: "side-action ownership: recipient's work vs Carson's (unresolved)" },
  { id: "A5", u: "Ask Christopher and Grace to set up the terrace for tonight.", reason: "multiple recipients (policy unresolved)" },
  { id: "WISH-STAFF", u: "Tell Grace I need her to call me.", reason: "staff wish-shaped request (not ruled)" },
] as const;

