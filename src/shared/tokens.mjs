// Brand token lookup. Pure: runs in Node and in the browser.

/** Resolve "$brand.colors.accent" against a brand kit, honouring a colourway. Returns undefined if it does not exist. */
export function resolveToken(token, brand, colourway) {
  const parts = token.split('.');
  if (parts[0] !== '$brand' || parts.length < 3) return undefined;
  if (parts[1] === 'colors' && colourway) {
    const swapped = brand.colourways?.[colourway]?.colors?.[parts[2]];
    if (swapped !== undefined) return swapped;
  }
  let value = brand;
  for (const p of parts.slice(1)) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, p)) return undefined;
    value = value[p];
  }
  return value;
}
