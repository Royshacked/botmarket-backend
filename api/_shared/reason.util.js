// Map a service `result.reason` to an HTTP status. `not_found` → 404, `forbidden` → 403,
// anything else → the given fallback (400 for a bad-request-y failure, 500 for internal).
// Shared by controllers so the terse reason→status ladder lives in one place.
export function reasonToStatus(reason, fallback = 400) {
    if (reason === 'not_found') return 404
    if (reason === 'forbidden') return 403
    return fallback
}
