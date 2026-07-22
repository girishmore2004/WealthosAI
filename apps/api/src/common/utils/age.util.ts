// Shared by RetirementService and SimulatorService — both need "current age" derived
// from the user's date of birth, with the same fallback when it hasn't been set yet.
export function calculateAge(dateOfBirth: Date | null | undefined, fallbackAge = 30): number {
  if (!dateOfBirth) return fallbackAge;
  return Math.floor((Date.now() - dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000));
}
