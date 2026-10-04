import type { AiDataCategory, AiInputMode, AiProvider } from "./ai-consent-authority";

export interface AiTransferManifest {
  id: string;
  provider: AiProvider;
  purpose: string;
  possibleDataCategories: readonly AiDataCategory[];
  inputModes: readonly AiInputMode[];
  rawBytesMayLeave: boolean;
  conversationContextMayBeIncluded: boolean;
  memoryMayBeIncluded: boolean;
}

const manifest = (value: AiTransferManifest) => value;
export const AI_TRANSFER_MANIFESTS = {
  anthropicGeneralCarsonReasoning: manifest({ id: "anthropic.general_carson_reasoning", provider: "anthropic", purpose: "carson_reasoning", possibleDataCategories: ["user_text", "conversation_history", "carson_memory", "operational_context"], inputModes: ["text", "voice"], rawBytesMayLeave: false, conversationContextMayBeIncluded: true, memoryMayBeIncluded: true }),
  anthropicInstructionExtraction: manifest({ id: "anthropic.instruction_extraction", provider: "anthropic", purpose: "instruction_extraction", possibleDataCategories: ["user_text", "people_data", "task_data", "reminder_data", "delegation_data"], inputModes: ["text", "voice", "whatsapp"], rawBytesMayLeave: false, conversationContextMayBeIncluded: false, memoryMayBeIncluded: false }),
  anthropicConversationMemory: manifest({ id: "anthropic.conversation_memory", provider: "anthropic", purpose: "conversation_memory_derivation", possibleDataCategories: ["conversation_history", "user_text", "carson_memory"], inputModes: ["text", "voice"], rawBytesMayLeave: false, conversationContextMayBeIncluded: true, memoryMayBeIncluded: true }),
  anthropicPlanningOperations: manifest({ id: "anthropic.planning_operations", provider: "anthropic", purpose: "planning_operations", possibleDataCategories: ["user_text", "people_data", "task_data", "reminder_data", "delegation_data", "calendar_data", "operational_context"], inputModes: ["text", "voice"], rawBytesMayLeave: false, conversationContextMayBeIncluded: true, memoryMayBeIncluded: false }),
  anthropicPeopleInsight: manifest({ id: "anthropic.people_insight", provider: "anthropic", purpose: "people_behavioral_insight", possibleDataCategories: ["people_data", "task_data", "conversation_history"], inputModes: ["text", "voice"], rawBytesMayLeave: false, conversationContextMayBeIncluded: true, memoryMayBeIncluded: false }),
  anthropicMessageReasoning: manifest({ id: "anthropic.message_reasoning", provider: "anthropic", purpose: "direct_message_delegation_reasoning", possibleDataCategories: ["user_text", "people_data", "task_data", "delegation_data"], inputModes: ["text", "voice", "whatsapp"], rawBytesMayLeave: false, conversationContextMayBeIncluded: false, memoryMayBeIncluded: false }),
  anthropicOperationalState: manifest({ id: "anthropic.operational_state", provider: "anthropic", purpose: "operational_state_reasoning", possibleDataCategories: ["user_text", "task_data", "reminder_data", "delegation_data", "calendar_data", "operational_context"], inputModes: ["text", "voice"], rawBytesMayLeave: false, conversationContextMayBeIncluded: true, memoryMayBeIncluded: false }),
  anthropicStaffWhatsapp: manifest({ id: "anthropic.staff_whatsapp", provider: "anthropic", purpose: "staff_message_reasoning", possibleDataCategories: ["staff_message", "people_data", "task_data", "household_rules", "carson_memory"], inputModes: ["whatsapp"], rawBytesMayLeave: false, conversationContextMayBeIncluded: true, memoryMayBeIncluded: true }),
  anthropicProofPhoto: manifest({ id: "anthropic.proof_photo", provider: "anthropic", purpose: "proof_photo_review", possibleDataCategories: ["image", "task_data", "delegation_data", "staff_message", "household_rules"], inputModes: ["whatsapp"], rawBytesMayLeave: true, conversationContextMayBeIncluded: false, memoryMayBeIncluded: false }),
  anthropicOwnerWhatsappImage: manifest({ id: "anthropic.owner_whatsapp_image", provider: "anthropic", purpose: "owner_image_interpretation", possibleDataCategories: ["image", "user_text"], inputModes: ["whatsapp"], rawBytesMayLeave: true, conversationContextMayBeIncluded: false, memoryMayBeIncluded: false }),
  elevenlabsTypedCarson: manifest({ id: "elevenlabs.typed_carson", provider: "elevenlabs", purpose: "carson_conversation", possibleDataCategories: ["user_text", "conversation_history", "operational_context", "account_identifier"], inputModes: ["text"], rawBytesMayLeave: false, conversationContextMayBeIncluded: true, memoryMayBeIncluded: true }),
  elevenlabsVoiceCarson: manifest({ id: "elevenlabs.voice_carson", provider: "elevenlabs", purpose: "carson_conversation", possibleDataCategories: ["audio", "user_text", "conversation_history", "operational_context"], inputModes: ["voice"], rawBytesMayLeave: true, conversationContextMayBeIncluded: true, memoryMayBeIncluded: true }),
  elevenlabsSessionContext: manifest({ id: "elevenlabs.session_context", provider: "elevenlabs", purpose: "carson_context_initialization", possibleDataCategories: ["account_identifier", "carson_memory", "operational_context", "weather_data", "persistent_instructions", "task_data", "reminder_data", "delegation_data", "calendar_data"], inputModes: ["text", "voice"], rawBytesMayLeave: false, conversationContextMayBeIncluded: true, memoryMayBeIncluded: true }),
  elevenlabsOwnerWhatsapp: manifest({ id: "elevenlabs.owner_whatsapp", provider: "elevenlabs", purpose: "owner_whatsapp_conversation", possibleDataCategories: ["user_text", "people_data", "task_data", "carson_memory", "persistent_instructions"], inputModes: ["whatsapp"], rawBytesMayLeave: false, conversationContextMayBeIncluded: true, memoryMayBeIncluded: true }),
  openaiAudioTranscription: manifest({ id: "openai.audio_transcription", provider: "openai", purpose: "audio_transcription", possibleDataCategories: ["audio"], inputModes: ["audio_upload"], rawBytesMayLeave: true, conversationContextMayBeIncluded: false, memoryMayBeIncluded: false }),
} as const;
