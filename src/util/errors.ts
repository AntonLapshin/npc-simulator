// Shared error-message helper: extract a readable message from anything
// thrown. (Previously copy-pasted as private `errorMessage`/`errMsg`
// helpers in several modules.)

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
