import { Globe2 } from "lucide-react";

interface TargetInputProps {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export function TargetInput({ value, disabled, onChange }: TargetInputProps) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 block text-sm font-medium text-cyan-50/75">Domain or IP address</span>
      <span className="flex h-12 items-center gap-3 rounded-lg border border-white/10 bg-white/[0.06] px-3 shadow-inner shadow-black/20">
        <Globe2 className="h-5 w-5 shrink-0 text-signal-cyan" aria-hidden="true" />
        <input
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder="cloudflare.com"
          className="min-w-0 flex-1 bg-transparent text-base text-white placeholder:text-white/35 disabled:cursor-not-allowed disabled:text-white/45"
        />
      </span>
    </label>
  );
}
