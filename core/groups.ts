import type { Granularity } from "./host-api";
import type { Block } from "./model";

/** Unit ids shown together for `unitId` at the given granularity (display only; never affects translation). */
export function groupUnits(block: Block, unitId: string, gran: Granularity): string[] {
  const ids = block.sentences.map((s) => s.id);
  const i = ids.indexOf(unitId);
  if (i < 0) return [unitId];
  if (gran === "para") return ids;
  const start = Math.floor(i / gran) * gran;
  return ids.slice(start, start + gran);
}

/** Block id of a unit id (`${blockId}:${n}`). */
export function blockIdOf(unitId: string): string {
  return unitId.slice(0, unitId.lastIndexOf(":"));
}
