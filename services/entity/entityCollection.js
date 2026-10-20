// Single source of truth for the physical entity-collection name. Every module that reaches the
// entity store imports ENTITIES from here, so the P2 cutover ('ideas' → 'entities') and any future
// rename is a one-line change. See docs/architecture/entity-model.md P2.
//
// During P1b the execution facade still named 'ideas' inline (entityRepo.EXEC_COLLECTION); P2b
// repoints entityRepo + the CRUD + the portfolio/monitor readers to this constant.

export const ENTITIES = 'entities'

// The PRE-cutover copy: the P2 cutover copied `ideas` into `entities` and left the old collection behind. Nothing
// reads it; the unified-chat migration (phase 9) unsets the retired Idea agent's transcripts on it too. Dropping it
// is its own decision — it is named here so that one place says what it was.
export const LEGACY_IDEAS = 'ideas'
