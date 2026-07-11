import type { ReactNode } from "react";

export const fieldSurface = { background: "#0C0D0F", borderColor: "#26272B" } as const;

export const fieldInputClass =
  "w-full rounded-[6px] border px-[14px] py-[11px] text-[14px] text-white outline-none placeholder:text-[#6B6B73]";

interface Props {
  label: string;
  children: ReactNode;
  className?: string;
}

export function LabeledField({ label, children, className }: Props) {
  return (
    <div className={`flex flex-col gap-[7px] ${className ?? ""}`}>
      <span className="text-[13px] font-medium" style={{ color: "#A1A1AA" }}>
        {label}
      </span>
      {children}
    </div>
  );
}
