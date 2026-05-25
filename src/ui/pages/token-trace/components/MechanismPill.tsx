/**
 * MechanismPill — small colored chip naming a token-savings mechanism.
 * Uses the shared MECH_COLORS palette.
 */

import { mc } from "../shared";

export function MechanismPill({ mechanism }: { mechanism: string }) {
  const colors = mc(mechanism);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 ${colors.bg} ${colors.text} text-[10px] font-medium ring-1 ring-inset ${colors.ring}`}
    >
      <span className={`h-1 w-1 rounded-full ${colors.bar}`} aria-hidden />
      {mechanism.replace(/_/g, " ")}
    </span>
  );
}
