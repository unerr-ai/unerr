/**
 * MechanismPill — small colored chip naming a token-savings mechanism.
 * Uses the shared MECH_COLORS palette.
 */

import { mc } from "../shared";

export function MechanismPill({ mechanism }: { mechanism: string }) {
  const colors = mc(mechanism);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 ${colors.bg} ${colors.text} text-[10px] font-medium`}
    >
      {mechanism.replace(/_/g, " ")}
    </span>
  );
}
