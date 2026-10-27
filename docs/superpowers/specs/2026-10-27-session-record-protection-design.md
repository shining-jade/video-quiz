# Preserve classroom records during allocation recovery

The user approved fixing allocation cleanup and testing with three synthetic students. No public deployment was approved. Production sessions and real student data must never be destructive test fixtures.

Allocation rollback may delete only an unactivated, empty allocating/aborted session belonging to the exact owner/token. A live session, even after heartbeat expiry, and any session with participant, response, grade, score, or aggregate participation evidence must be preserved. Server reads must establish emptiness; read errors, cached results, malformed counters, and concurrent activation must fail closed. Normal endSession continues to retain results.

Use the existing store, transaction, and emulator test patterns. Tighten local Firestore rules without granting any access. Explain protected records separately from a temporary heartbeat delay. Keep the original quiz and settings unchanged. Leave deployment for explicit approval.
