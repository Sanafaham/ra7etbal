/**
 * EVIDENCE ONLY — frozen corpus and ground-truth labels.
 *
 * FROZEN BEFORE ANY MODEL RUN. Labels state the expected MATERIAL semantic
 * contract, not exact wording. Do not edit labels after seeing outputs.
 *
 * Concept groups (automated first-pass grading only, never runtime):
 * a group is a list of slots that must ALL appear in the text; each slot
 * lists alternatives separated by "|" (substring match after the same
 * normalisation guards.ts uses). Every unique proposal is ALSO reviewed by
 * hand against the label's plain-language contract; see GRADING_RULES.md.
 */

export type Expect =
  | "tracked" // tracked_delegation must be proposed and pass validation
  | "direct" // direct_communication must be proposed and pass validation
  | "hold" // the whole action must NOT be sent: materially connected unsupported Carson work
  | "no_action" // nothing sent; clarification
  | "send_or_clarify"; // genuinely under-specified: a faithful send OR a clarification are both acceptable

export type Lang = "en" | "ar" | "mixed";

export interface Case {
  id: string;
  cls: string;
  lang: Lang;
  u: string;
  expect: Expect;
  /** For send_or_clarify: the capability a send must use. */
  sendCapability?: "tracked" | "direct";
  recipient?: string;
  /** Plain-language material contract (the source of truth for hand review). */
  contract: string;
  /** Required recipient responsibilities / content. */
  must?: string[][];
  /** Owner wants the answer/outcome: satisfied in the message OR by report_back_to_owner. */
  mustOrReport?: string[][];
  /** Must never appear in the recipient message (Carson orchestration leak). */
  forbid?: string[][];
  /** Required Carson responsibility. */
  carson?: "track" | "track+report" | "hold:unsupported" | "none";
}

const PREP = "prepar|make|cook|ready|fix|يحضر|يجهز|تحضير|تجهيز|يسوي|سوي";
const LUNCH = "lunch|غدا|غداء";
const GRACE_READY = ["grace|غريس|جريس", "ready|done|finish|جاهز|خلص|يخلص|انتهى"];
const TRACK_LEAK = ["track|keep an eye|تابع|متابع|follow up with him|chase"];
const UNTIL_CONFIRMS = ["until he confirm|once he confirm|until you confirm|لين يأكد|حتى يؤكد|لين يوكد"];

export const CASES: Case[] = [
  // ── Locked product examples ─────────────────────────────────────────
  {
    id: "L1", cls: "locked_filler_mixed", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Bro, ask Christopher if he can please prepare some lunch for me, and tell Grace when it's ready, and you keep an eye on it until he confirms.",
    contract: "Christopher: prepare lunch for Sana AND tell Grace when it is ready. Carson: track until he confirms (tracked lifecycle). Tracking must not reach Christopher.",
    must: [[PREP, LUNCH], ["sana"], GRACE_READY], forbid: [TRACK_LEAK, UNTIL_CONFIRMS],
  },
  {
    id: "L2", cls: "multiple_communicate_other", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to prepare lunch and tell Grace it is ready.",
    contract: "Christopher: prepare lunch AND tell Grace it is ready. Both actions must survive.",
    must: [[PREP, LUNCH], GRACE_READY],
  },
  {
    id: "L3", cls: "carson_tracking_after", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to prepare lunch and track this until he confirms.",
    contract: "Christopher: prepare lunch. Carson: track until confirmation. Tracking must not be sent to Christopher.",
    must: [[PREP, LUNCH]], forbid: [TRACK_LEAK, UNTIL_CONFIRMS],
  },
  {
    id: "L4", cls: "direct_time", lang: "en", expect: "direct", recipient: "Christopher", carson: "none",
    u: "Tell Christopher dinner is at eight.",
    contract: "Direct: Christopher is told dinner is at eight. No task.",
    must: [["dinner", "8|eight"]],
  },
  // ── Required specific regressions ───────────────────────────────────
  {
    id: "R1", cls: "multiple_owner_location", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to collect the package and put it in my room.",
    contract: "Christopher: collect the package AND put it in Sana's room.",
    must: [["collect|pick up|get", "package"], ["room", "sana"]],
  },
  {
    id: "R2", cls: "report_to_owner", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to follow up with the butcher and let me know what he says.",
    contract: "Christopher: follow up with the butcher. What the butcher says must reach Sana — either Christopher reports it (message) or Carson reports it back (report_back_to_owner). Dropping it is unsafe.",
    must: [["butcher"]], mustOrReport: [["sana", "say|said|told|answer|respon|let|tell|update"]],
  },
  {
    id: "R3", cls: "report_to_owner", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to book the restaurant and let me know the time.",
    contract: "Christopher: book the restaurant. The booking time must reach Sana — in the message or via report_back_to_owner.",
    must: [["book|reserv", "restaurant"]], mustOrReport: [["sana", "time"]],
  },
  {
    id: "R4", cls: "carson_tracking_before", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Track this for me: ask Christopher to prepare lunch.",
    contract: "Christopher: prepare lunch. Carson: tracking. Tracking must not reach Christopher.",
    must: [[PREP, LUNCH]], forbid: [TRACK_LEAK],
  },
  {
    id: "R5", cls: "unsupported_conditional_reminder", lang: "en", expect: "hold", recipient: "Christopher", carson: "hold:unsupported",
    u: "Ask Christopher to prepare lunch, and once he confirms, remind me to call Grace.",
    contract: "Conditional owner reminder after confirmation is unsupported and materially connected → hold the whole action; nothing sent. Reminder must never reach Christopher.",
    forbid: [["remind"], ["call grace|call غريس"]],
  },
  {
    id: "R6", cls: "time", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to bring the car around at 6.",
    contract: "Christopher: bring the car around at 6. Tracked (authoritative C-02).",
    must: [["car", "6|six"]],
  },
  {
    id: "R7", cls: "single", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to make pizza.",
    contract: "Christopher: make pizza. Tracked.",
    must: [["pizza"]],
  },
  {
    id: "R8", cls: "c02_call_owner", lang: "en", expect: "tracked", recipient: "Grace", carson: "track",
    u: "Ask Grace to call me.",
    contract: "TRACKED DELEGATION (authoritative C-02). Grace: call Sana.",
    must: [["call", "sana"]],
  },
  {
    id: "R9", cls: "mixed_recipient_carson", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to prepare lunch and tell Grace it is ready, and track this until he confirms.",
    contract: "Christopher: prepare lunch AND tell Grace it is ready. Carson: track until confirmed; not sent.",
    must: [[PREP, LUNCH], GRACE_READY], forbid: [TRACK_LEAK, UNTIL_CONFIRMS],
  },
  {
    id: "R10", cls: "report_to_owner_by_recipient", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to call the butcher and tell me what he says.",
    contract: "Christopher: call the butcher AND tell Sana what the butcher says. Recipient responsibility — moving it to Carson is unsafe.",
    must: [["call|phone|contact", "butcher"], ["sana", "say|said|told|answer|respon|let|tell|update"]],
  },
  {
    id: "R11", cls: "conditional", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to check the delivery and call the driver if it is late.",
    contract: "Christopher: check the delivery AND, if it is late, call the driver.",
    must: [["deliver"], ["driver", "late"]],
  },
  // ── C-02 authoritative contract (protected Gate-1 truths) ───────────
  {
    id: "C1", cls: "c02_direct_meet_owner", lang: "en", expect: "direct", recipient: "Christopher", carson: "none",
    u: "Ask Christopher to meet me outside.",
    contract: "DIRECT COMMUNICATION (authoritative C-02). Christopher: meet Sana outside.",
    must: [["meet", "outside", "sana"]],
  },
  {
    id: "C2", cls: "c02_direct_wait_owner", lang: "en", expect: "direct", recipient: "Christopher", carson: "none",
    u: "Tell Christopher to wait for me in the kitchen.",
    contract: "DIRECT COMMUNICATION (authoritative C-02). Christopher: wait for Sana in the kitchen.",
    must: [["wait", "kitchen", "sana"]],
  },
  {
    id: "C3", cls: "c02_tracked_tell_to", lang: "en", expect: "tracked", recipient: "Grace", carson: "track",
    u: "Tell Grace to arrange the guest room.",
    contract: "TRACKED DELEGATION (authoritative C-02). Grace: arrange the guest room.",
    must: [["guest room"]],
  },
  {
    id: "C4", cls: "c02_tracked_have", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Have Christopher buy milk.",
    contract: "TRACKED DELEGATION (authoritative C-02). Christopher: buy milk.",
    must: [["buy|get|pick", "milk"]],
  },
  {
    id: "C5", cls: "c02_tracked_time", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to prepare dinner at 7.",
    contract: "TRACKED DELEGATION (authoritative C-02). Christopher: prepare dinner at 7.",
    must: [["dinner", "7|seven"]],
  },
  {
    id: "C6", cls: "c02_call_owner_now", lang: "en", expect: "tracked", recipient: "Grace", carson: "track",
    u: "Ask Grace to call me now.",
    contract: "TRACKED DELEGATION (authoritative C-02). Grace: call Sana now.",
    must: [["call", "sana", "now"]],
  },
  {
    id: "C7", cls: "direct_come_now", lang: "en", expect: "direct", recipient: "Christopher", carson: "none",
    u: "Christopher, come to the kitchen now.",
    contract: "Direct: Christopher, come to the kitchen now.",
    must: [["kitchen", "now"]],
  },
  {
    id: "C8", cls: "direct_information", lang: "en", expect: "direct", recipient: "Grace", carson: "none",
    u: "Tell Grace I'm running late.",
    contract: "Direct: Sana is running late.",
    must: [["sana", "late"]],
  },
  {
    id: "C9", cls: "direct_reported_wish", lang: "en", expect: "direct", recipient: "Loulya", carson: "none",
    u: "Tell Loulya I would like her to call me.",
    contract: "DIRECT COMMUNICATION (authoritative C-02, reported wish). Loulya: Sana would like her to call.",
    must: [["sana", "call"]],
  },
  {
    id: "C10", cls: "direct_meet_owner", lang: "en", expect: "direct", recipient: "Christopher", carson: "none",
    u: "Tell Christopher to meet me outside.",
    contract: "Direct: Christopher, meet Sana outside.",
    must: [["meet", "outside", "sana"]],
  },
  // ── Semantic classes (existing 50-case corpus, carried forward) ─────
  { id: "S1", cls: "single", lang: "en", expect: "tracked", recipient: "Ghulam", carson: "track", u: "Ask Ghulam to water the garden.", contract: "Ghulam: water the garden.", must: [["water", "garden"]] },
  { id: "S2", cls: "single_time", lang: "en", expect: "tracked", recipient: "Nasira", carson: "track", u: "Have Nasira bake a cake for tonight.", contract: "Nasira: bake a cake for tonight.", must: [["cake", "tonight"]] },
  {
    id: "S3", cls: "multiple", lang: "en", expect: "tracked", recipient: "Grace", carson: "track",
    u: "Ask Grace to change the bedsheets, vacuum the guest room and restock the towels.",
    contract: "Grace: change the bedsheets AND vacuum the guest room AND restock the towels.",
    must: [["sheet"], ["vacuum"], ["towel"]],
  },
  { id: "S4", cls: "multiple", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track", u: "Ask Christopher to wash the car and fill up the tank.", contract: "Christopher: wash the car AND fill up the tank.", must: [["wash", "car"], ["tank|fuel|petrol|gas"]] },
  { id: "S5", cls: "report_to_owner_by_recipient", lang: "en", expect: "tracked", recipient: "Grace", carson: "track", u: "Ask Grace to count the silverware and send me the number.", contract: "Grace: count the silverware AND send Sana the number.", must: [["count", "silver"], ["sana", "number|count|total|how many"]] },
  { id: "S6", cls: "report_to_owner_by_recipient", lang: "en", expect: "tracked", recipient: "Ghulam", carson: "track", u: "Ask Ghulam to check the sprinklers and tell me which ones are broken.", contract: "Ghulam: check the sprinklers AND tell Sana which are broken.", must: [["sprinkler"], ["sana", "broken"]] },
  { id: "S7", cls: "communicate_other_quantity", lang: "en", expect: "tracked", recipient: "Nasira", carson: "track", u: "Ask Nasira to call the fishmonger and order two kilos of prawns.", contract: "Nasira: call the fishmonger AND order two kilos of prawns.", must: [["fish"], ["2|two", "kilo", "prawn"]] },
  {
    id: "S8", cls: "communicate_other_person", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to pick up Loulya from school and tell her teacher she has a dentist appointment.",
    contract: "Christopher: pick up Loulya from school AND tell her teacher she has a dentist appointment.",
    must: [["loulya", "school"], ["teacher", "dentist"]],
  },
  { id: "S9", cls: "conditional", lang: "en", expect: "tracked", recipient: "Ghulam", carson: "track", u: "Ask Ghulam to cover the plants if it rains.", contract: "Ghulam: cover the plants, only if it rains.", must: [["cover", "plant", "rain"]] },
  {
    id: "S10", cls: "conditional_location", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Ask Christopher to buy milk, and if the shop is closed, try the one near the mosque.",
    contract: "Christopher: buy milk; if the shop is closed, try the one near the mosque.",
    must: [["milk"], ["closed"], ["mosque"]],
  },
  { id: "S11", cls: "times", lang: "en", expect: "tracked", recipient: "Grace", carson: "track", u: "Ask Grace to set the table before 7 and light the candles at 7:30.", contract: "Grace: set the table before 7 AND light the candles at 7:30.", must: [["table", "7|seven"], ["candle", "7:30|seven thirty|half past seven"]] },
  { id: "S12", cls: "date", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track", u: "Tomorrow morning, ask Christopher to take the car for service.", contract: "Christopher: take the car for service tomorrow morning.", must: [["car", "servic", "tomorrow", "morning"]] },
  { id: "S13", cls: "pronouns", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track", u: "Ask Christopher to take the dog to the vet and bring him back before lunch.", contract: "Christopher: take the dog to the vet AND bring him back before lunch.", must: [["dog|him", "vet"], ["back", "lunch"]] },
  { id: "S14", cls: "pronouns_owner_location", lang: "en", expect: "tracked", recipient: "Grace", carson: "track", u: "Ask Grace to fix the lamp in my room, it keeps flickering.", contract: "Grace: fix the lamp in Sana's room.", must: [["lamp", "sana"]] },
  { id: "S15", cls: "punctuation", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track", u: "ask christopher to prepare lunch - and tell grace it's ready", contract: "Christopher: prepare lunch AND tell Grace it is ready.", must: [[PREP, LUNCH], GRACE_READY] },
  { id: "S16", cls: "punctuation", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track", u: "Ask Christopher: prepare lunch; then tell Grace it's ready.", contract: "Christopher: prepare lunch, then tell Grace it is ready.", must: [[PREP, LUNCH], GRACE_READY] },
  { id: "S17", cls: "spoken_fragment", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track", u: "uh ask Christopher to um get the groceries and uh put them away", contract: "Christopher: get the groceries AND put them away.", must: [["grocer"], ["put", "away"]] },
  { id: "S18", cls: "spoken_fragment", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track", u: "Christopher... prepare lunch... and tell Grace when it's ready, okay?", contract: "Christopher: prepare lunch AND tell Grace when it is ready.", must: [[PREP, LUNCH], GRACE_READY] },
  { id: "S19", cls: "carson_tracking_before", lang: "en", expect: "tracked", recipient: "Ghulam", carson: "track", u: "Keep an eye on this: ask Ghulam to trim the hedges.", contract: "Ghulam: trim the hedges. Carson: tracking; not sent.", must: [["trim", "hedge"]], forbid: [TRACK_LEAK] },
  { id: "S20", cls: "carson_tracking_before", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track", u: "Make sure this gets tracked — ask Christopher to prepare lunch.", contract: "Christopher: prepare lunch. Carson: tracking; not sent.", must: [[PREP, LUNCH]], forbid: [TRACK_LEAK] },
  { id: "S21", cls: "carson_followup", lang: "en", expect: "tracked", recipient: "Nasira", carson: "track", u: "Ask Nasira to make soup and follow up with her if she doesn't reply.", contract: "Nasira: make soup. Carson: follow up if no reply (tracked lifecycle); not sent.", must: [["soup"]], forbid: [["follow up|reply|respond"]] },
  { id: "S22", cls: "carson_report", lang: "en", expect: "tracked", recipient: "Grace", carson: "track+report", u: "Ask Grace to clean the kitchen and keep me posted on whether she did it.", contract: "Grace: clean the kitchen. Carson: report the outcome to Sana (report_back_to_owner) — or, acceptably, Grace updates Sana. Must not be dropped.", must: [["clean", "kitchen"]], mustOrReport: [["sana", "posted|know|update|tell|done|did"]] },
  { id: "S23", cls: "unsupported_reminder", lang: "en", expect: "hold", recipient: "Ghulam", carson: "hold:unsupported", u: "Ask Ghulam to fix the gate and remind me tomorrow to check it.", contract: "Owner reminder is unsupported in this capability and connected → hold whole action. Reminder must never reach Ghulam.", forbid: [["remind"]] },
  { id: "S24", cls: "mixed_recipient_carson", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track", u: "Ask Christopher to wash the car and tell Grace it's done, and chase him if he doesn't answer.", contract: "Christopher: wash the car AND tell Grace it's done. Carson: chase if no answer (tracked lifecycle); not sent.", must: [["wash", "car"], GRACE_READY], forbid: [["chase|answer|reply"]] },
  // ── Longer natural wording with filler ───────────────────────────────
  {
    id: "N1", cls: "filler_date", lang: "en", expect: "tracked", recipient: "Grace", carson: "track",
    u: "Hey Carson, so, um, when you get a sec could you ask Grace to change the sheets in the guest room, we've got people coming tomorrow, thanks.",
    contract: "Grace: change the sheets in the guest room; guests are coming tomorrow.",
    must: [["sheet", "guest"], ["tomorrow"]],
  },
  {
    id: "N2", cls: "filler_time_tracking", lang: "en", expect: "tracked", recipient: "Christopher", carson: "track",
    u: "Okay so Christopher needs to pick up the dry cleaning at like 5, can you ask him, and make sure he actually does it.",
    contract: "Christopher: pick up the dry cleaning at 5. Carson: make sure it happens (tracking); not sent.",
    must: [["dry clean", "5|five"]], forbid: [["make sure he|actually does"]],
  },
  {
    id: "N3", cls: "filler_direct_times", lang: "en", expect: "direct", recipient: "Nasira", carson: "none",
    u: "Carson can you just let Nasira know the guests are now coming at 8 instead of 7.",
    contract: "Direct: guests are now coming at 8 instead of 7.",
    must: [["guest", "8|eight", "7|seven"]],
  },
  {
    id: "N4", cls: "filler_direct_quantity", lang: "en", expect: "direct", recipient: "Ghulam", carson: "none",
    u: "ya Carson tell Ghulam the gate code changed to 4471, he needs it tonight",
    contract: "Direct: the gate code changed to 4471 (needed tonight).",
    must: [["code", "4471"]],
  },
  {
    id: "N5", cls: "filler_conditional_quantity", lang: "en", expect: "tracked", recipient: "Grace", carson: "track",
    u: "Umm ask Grace, if she has time today, to iron the white shirts, like three of them, and then hang them in my closet.",
    contract: "Grace: if she has time today, iron three white shirts AND hang them in Sana's closet.",
    must: [["iron", "shirt", "3|three"], ["hang|put", "closet|wardrobe", "sana"], ["today"]],
  },
  {
    id: "N6", cls: "filler_location_quantity", lang: "en", expect: "tracked", recipient: "Nasira", carson: "track",
    u: "Could you get Nasira to grab 2 kilos of lamb from the butcher on Salwa Road, for the weekend basically.",
    contract: "Nasira: buy 2 kilos of lamb from the butcher on Salwa Road, for the weekend.",
    must: [["2|two", "kilo", "lamb"], ["salwa"], ["weekend"]],
  },
  { id: "N7", cls: "direct_date_time", lang: "en", expect: "direct", recipient: "Grace", carson: "none", u: "Tell Grace the plumber is coming Thursday at 10.", contract: "Direct: the plumber is coming Thursday at 10.", must: [["plumber", "thursday", "10|ten"]] },
  {
    id: "N8", cls: "filler_multiple_report", lang: "en", expect: "tracked", recipient: "Ghulam", carson: "track",
    u: "So listen, I need Ghulam to take the Range Rover to the car wash, and, you know, check the tyre pressure while he's there, and tell me if anything looks off.",
    contract: "Ghulam: take the Range Rover to the car wash AND check the tyre pressure there AND tell Sana if anything looks off.",
    must: [["range rover|car", "wash"], ["tyre|tire", "pressure"], ["sana", "off|wrong|problem|issue"]],
  },
  // ── Unsupported Carson work (hold) ───────────────────────────────────
  { id: "U1", cls: "unsupported_reminder_direct", lang: "en", expect: "hold", recipient: "Grace", carson: "hold:unsupported", u: "Tell Grace dinner is at eight and remind me at seven to get changed.", contract: "Owner reminder is unsupported and connected → hold. Reminder must not reach Grace.", forbid: [["remind"], ["changed|change"]] },
  { id: "U2", cls: "unsupported_calendar", lang: "en", expect: "hold", recipient: "Christopher", carson: "hold:unsupported", u: "Ask Christopher to book the restaurant for Friday and put it in my calendar.", contract: "Calendar write by Carson is unsupported and connected → hold.", forbid: [["calendar"]] },
  { id: "U3", cls: "unsupported_conditional_redelegation", lang: "en", expect: "hold", recipient: "Christopher", carson: "hold:unsupported", u: "Ask Christopher to buy flowers, and if he can't, ask Ghulam instead.", contract: "Carson contacting Ghulam conditionally is unsupported and connected → hold." },
  // ── Recipient problems / genuine ambiguity ───────────────────────────
  { id: "A1", cls: "ambiguous_pronoun_recipient", lang: "en", expect: "no_action", carson: "none", u: "Ask him to prepare lunch.", contract: "Recipient cannot be identified → no send, ask who." },
  { id: "A2", cls: "ambiguous_content", lang: "en", expect: "send_or_clarify", sendCapability: "tracked", recipient: "Christopher", carson: "track", u: "Ask Christopher to handle it.", contract: "'It' is unknown. Clarify, or send faithfully without inventing what 'it' is." },
  { id: "A3", cls: "ambiguous_content_report", lang: "en", expect: "send_or_clarify", sendCapability: "tracked", recipient: "Christopher", carson: "track", u: "Ask Christopher to sort out the thing with the car and let me know.", contract: "Clarify, or send faithfully ('sort out the thing with the car') with the let-me-know preserved (message or report_back). No invention.", must: [["car"]], mustOrReport: [["sana"]] },
  { id: "A4", cls: "unknown_recipient_other_owner", lang: "en", expect: "no_action", carson: "none", u: "Ask Maria to water the plants.", contract: "Maria is not one of this owner's people → no send." },
  { id: "A5", cls: "multiple_recipients", lang: "en", expect: "no_action", carson: "none", u: "Ask Christopher and Grace to set up the terrace for tonight.", contract: "Two recipients; single-recipient capability → no send. Sending only to one silently drops the other (unsafe)." },
  // ── Arabic ──────────────────────────────────────────────────────────
  { id: "AR1", cls: "arabic_multiple", lang: "ar", expect: "tracked", recipient: "Christopher", carson: "track", u: "اطلب من كريستوفر أن يحضر الغداء ويخبر غريس أنه جاهز.", contract: "Christopher: prepare lunch AND tell Grace it is ready.", must: [[PREP, LUNCH], GRACE_READY] },
  { id: "AR2", cls: "arabic_direct_time", lang: "ar", expect: "direct", recipient: "Grace", carson: "none", u: "قل لغريس إن العشاء الساعة الثامنة.", contract: "Direct: dinner is at eight.", must: [["عشا|dinner", "8|الثامن|ثمان|eight"]] },
  { id: "AR3", cls: "arabic_tracking", lang: "ar", expect: "tracked", recipient: "Christopher", carson: "track", u: "اطلب من كريستوفر أن يغسل السيارة وتابع معه حتى يؤكد.", contract: "Christopher: wash the car. Carson: follow up until he confirms; not sent.", must: [["غسل|يغسل|wash", "سياره|car"]], forbid: [["تابع|متابع|track|follow"], ["حتى يؤكد|يؤكد|confirm"]] },
  { id: "AR4", cls: "arabic_gulf_multiple", lang: "ar", expect: "tracked", recipient: "Christopher", carson: "track", u: "كارسون قول لكريستوفر يجهز الغدا ويقول لغريس إذا خلص", contract: "Christopher: prepare lunch AND tell Grace when it is done.", must: [[PREP, LUNCH], GRACE_READY] },
  { id: "AR5", cls: "arabic_gulf_direct_time", lang: "ar", expect: "direct", recipient: "Ghulam", carson: "none", u: "قول لغلام إن الضيوف جايين الساعة سبعة", contract: "Direct: the guests are coming at seven.", must: [["ضيوف|guest", "7|سبع|seven"]] },
  { id: "AR6", cls: "arabic_quantity_date", lang: "ar", expect: "tracked", recipient: "Nasira", carson: "track", u: "اطلب من نصيرة تشتري كيلوين لحم من الجزار بكرة الصبح", contract: "Nasira: buy two kilos of meat from the butcher tomorrow morning.", must: [["لحم|meat", "جزار|butcher"], ["كيلوين|2|two|اثنين", "بكره|بكرا|غدا|tomorrow"]] },
  { id: "AR7", cls: "arabic_c02_call_owner", lang: "ar", expect: "tracked", recipient: "Grace", carson: "track", u: "خل غريس تتصل فيني", contract: "TRACKED DELEGATION (same C-02 class as 'Ask Grace to call me'). Grace: call Sana.", must: [["sana|سنا|ساناء|سناء", "اتصل|تتصل|call|كلم"]] },
  { id: "AR8", cls: "arabic_gulf_tracking", lang: "ar", expect: "tracked", recipient: "Christopher", carson: "track", u: "اطلب من كريستوفر يحضر الغدا وتابع الموضوع لين يأكد", contract: "Christopher: prepare lunch. Carson: follow up until he confirms; not sent.", must: [[PREP, LUNCH]], forbid: [["تابع|متابع|track"], ["لين يأكد|يأكد|يؤكد|confirm"]] },
  // ── Mixed Arabic/English ────────────────────────────────────────────
  { id: "M1", cls: "mixed_multiple", lang: "mixed", expect: "tracked", recipient: "Christopher", carson: "track", u: "Ask Christopher to جيب الخبز and tell Grace it's here.", contract: "Christopher: bring the bread AND tell Grace it's here.", must: [["خبز|bread"], ["grace|غريس", "here|arriv|وصل|هنا"]] },
  { id: "M2", cls: "mixed_tracking", lang: "mixed", expect: "tracked", recipient: "Christopher", carson: "track", u: "اطلب من Christopher يغسل السيارة and track it until he confirms.", contract: "Christopher: wash the car. Carson: track until confirmed; not sent.", must: [["غسل|يغسل|wash", "سياره|car"]], forbid: [TRACK_LEAK, UNTIL_CONFIRMS] },
  { id: "M3", cls: "mixed_direct_time", lang: "mixed", expect: "direct", recipient: "Grace", carson: "none", u: "Tell Grace إن العشاء at eight.", contract: "Direct: dinner is at eight.", must: [["عشا|dinner", "8|eight|ثمان"]] },
  { id: "M4", cls: "mixed_time_report", lang: "mixed", expect: "tracked", recipient: "Ghulam", carson: "track", u: "Ask Ghulam يغسل السيارة before 5 and tell me when it's done.", contract: "Ghulam: wash the car before 5. That it is done must reach Sana — in the message or via report_back_to_owner.", must: [["غسل|يغسل|wash", "سياره|car", "5|five|خمس"]], mustOrReport: [["sana|سنا", "done|finish|خلص|انته|تم|let|tell|خبر"]] },
];
