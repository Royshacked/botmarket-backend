// Mentor's build conversation over HTTP. The desk itself — its parse, its agent call, what reaches the
// panel — is services/desks/mentor.desk.js, shared with the session turn (unified-chat plan phase 4).

import { makeDeskStream } from '../_shared/deskStream.util.js'
import { mentorDesk } from '../../services/desks/mentor.desk.js'

export const streamMentor = makeDeskStream(mentorDesk)
