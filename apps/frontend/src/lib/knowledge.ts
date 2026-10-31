/** "Annual, Premium monthly" -> ['Annual', 'Premium monthly']; empty means every plan. */
export function parsePlans(value: string): string[] {
  return [...new Set(value.split(',').map(plan => plan.trim()).filter(Boolean))].slice(0, 20)
}
