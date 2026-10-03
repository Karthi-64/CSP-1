import { useRef, useState } from "react";
import { supabase } from "../lib/supabase";

interface Props {
  onUploaded: () => void;
}

interface UploadResult {
  tier: 1 | 2;
  deduplicated: boolean;
  extraction_ok?: boolean;
  extraction_reason?: string;
  near_duplicate_pairs?: number;
}

export function Uploader({ onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    setLog([]);
    const messages: string[] = [];
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const { data, error } = await supabase.functions.invoke<UploadResult>(
          "process-upload",
          { body: form },
        );
        if (error) throw new Error(`${file.name}: ${error.message}`);
        if (data) {
          if (data.deduplicated) {
            messages.push(
              `${file.name}: identical bytes already stored — shared blob (Tier 1).`,
            );
          } else {
            const note = data.extraction_ok
              ? "text extracted"
              : `metadata-only (${data.extraction_reason ?? "no text"})`;
            messages.push(
              `${file.name}: stored — ${note}; ${data.near_duplicate_pairs ?? 0} possible duplicate(s).`,
            );
          }
        }
      }
      setLog(messages);
      onUploaded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="card uploader">
      <div className="uploader-row">
        <label className="file-btn">
          <input
            ref={inputRef}
            type="file"
            multiple
            onChange={(e) => handleFiles(e.target.files)}
            disabled={busy}
            hidden
          />
          {busy ? "Uploading…" : "Choose files"}
        </label>
        <span className="muted small">
          docx · pptx · xlsx · pdf · txt · md · csv — hashed, deduplicated, and
          compared on upload.
        </span>
      </div>
      {error && <p className="error">{error}</p>}
      {log.length > 0 && (
        <ul className="upload-log">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
