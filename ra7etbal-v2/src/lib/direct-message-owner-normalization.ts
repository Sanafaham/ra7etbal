/**
 * App-side entry point to the single authoritative owner-perspective
 * boundary (shared/owner-perspective.js). Every recipient-facing text built
 * from the owner's words — direct messages, delegation messages, stored task
 * descriptions, personal notes — resolves owner / recipient / third-party /
 * quoted roles there before rendering, and fails closed (status
 * "needs_composition", or OwnerPerspectiveError) when perspective cannot be
 * resolved safely. Nothing else in the app rewrites owner pronouns.
 */
export {
  OWNER_PERSPECTIVE_UNRESOLVED,
  OwnerPerspectiveError,
  isOwnerPerspectiveError,
  ownerPerspectiveClarification,
  ownerPerspectiveDetail,
  renderOwnerPerspective,
  resolveOwnerPerspective,
} from "../../shared/owner-perspective.js";
export type { OwnerPerspectiveOptions, OwnerPerspectiveResult, OwnerPerspectiveVoice } from "../../shared/owner-perspective.js";
