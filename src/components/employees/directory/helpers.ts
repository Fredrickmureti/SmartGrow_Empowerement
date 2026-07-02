export function positionName(
  id: string | null | undefined,
  positions: { id: string; name: string }[],
) {
  if (!id) return "";
  return positions.find((p) => p.id === id)?.name || "";
}

export function locationName(
  id: string | null | undefined,
  locations: { id: string; name: string }[],
) {
  if (!id) return "";
  return locations.find((l) => l.id === id)?.name || "";
}