import { useEffect, useRef, useState } from "react";
import type React from "react";
import { useDashboardStore } from "../store";
import type { SendFn } from "../views";

export function OtpModal({ send }: { send: SendFn }) {
  const prompt = useDashboardStore((s) => s.otpPrompt);
  const close = useDashboardStore((s) => s.closeOtpPrompt);
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [secondsLeft, setSecondsLeft] = useState(300);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!prompt?.open) return;
    setDigits(Array(6).fill(""));
    setSecondsLeft(300);
    firstRef.current?.focus();
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [prompt?.open]);

  if (!prompt?.open) return null;
  const activePrompt = prompt;

  function submit(code: string) {
    send({ type: "auth:otp-submit", id: crypto.randomUUID(), payload: { profile: activePrompt.profile, otp: code } });
    close();
  }
  function setDigit(i: number, v: string) {
    const d = [...digits];
    d[i] = v.replace(/\D/g, "").slice(-1);
    setDigits(d);
    if (v && i < 5) (document.querySelectorAll<HTMLInputElement>(".otp-input")[i + 1])?.focus();
    if (d.every((x) => x.length === 1)) submit(d.join(""));
  }
  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const raw = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (raw.length === 6) { setDigits(raw.split("")); submit(raw); }
  }
  function cancel() { close(); }

  return (
    <div className="otp-modal-backdrop" role="dialog" aria-modal="true">
      <div className="otp-modal">
        <h3>Enter the code from your email</h3>
        <p className="otp-email">{prompt.email}</p>
        <div className="otp-inputs">
          {digits.map((d, i) => (
            <input key={i} ref={i === 0 ? firstRef : undefined} className="otp-input" maxLength={1} value={d}
              onChange={(e) => setDigit(i, e.target.value)} onPaste={handlePaste} inputMode="numeric" />
          ))}
        </div>
        <div className="otp-footer">
          <span>{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</span>
          <button onClick={cancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
