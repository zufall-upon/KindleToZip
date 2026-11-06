// Do not return a visibility-filtered locator: an auto-hiding control would
// disappear from that lookup between its visibility check and metadata reads.
// The caller still verifies visibility and its previously bound node identity.
export async function uniqueVisibleCandidate(locator, previouslyBound = null) {
  const count = await locator.count();
  const visible = await Promise.all(Array.from({ length: count }, (_, index) => locator.nth(index).isVisible()));
  const indices = visible.flatMap((value, index) => value ? [index] : []);
  if (indices.length === 1) return locator.nth(indices[0]);
  if (indices.length === 0 && previouslyBound) {
    const index = await locator.evaluateAll((elements, original) => elements.indexOf(original), previouslyBound);
    if (index >= 0) return locator.nth(index);
  }
  return null;
}
