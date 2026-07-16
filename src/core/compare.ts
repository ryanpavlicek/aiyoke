/** Locale-independent Unicode code-point ordering for reproducible generation. */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) ?? -1;
    const rightPoint = rightPoints[index]?.codePointAt(0) ?? -1;
    if (leftPoint < rightPoint) return -1;
    if (leftPoint > rightPoint) return 1;
  }
  return leftPoints.length - rightPoints.length;
}
