/** The order of the harness permission presets in the composer. */

const AUTO = 'auto'
const FULL_ACCESS = 'danger-full-access'
const AUTO_POSITION = 2

/**
 * Put Auto third and Full access last. The other presets keep their order.
 * @param options - the presets, in catalog order.
 * @returns the presets, in the order that the composer shows.
 */
export function orderAccessPresets<T extends { readonly value: string }>(options: readonly T[]): T[] {
  const ordered = options.filter(option => option.value !== AUTO && option.value !== FULL_ACCESS)
  const auto = options.find(option => option.value === AUTO)
  const full = options.find(option => option.value === FULL_ACCESS)
  if (auto !== undefined) ordered.splice(Math.min(AUTO_POSITION, ordered.length), 0, auto)
  if (full !== undefined) ordered.push(full)
  return ordered
}
