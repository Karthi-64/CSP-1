import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { renderWordDiff } from "../lib/diff";
import { excerpt, formatBytes, formatDate, formatPercent } from "../lib/format";
import {
  CONFIDENCE_LABEL,
  type FileText,
  type LogicalFile,
  type NearDuplicatePair,
} from "../lib/types";

interface Props {
  pair: NearDuplicatePair;
  fileA: LogicalFile;
  fileB: LogicalFile;
  onClose: () => void;
  onChanged: (close: boolean) => void;
}

interface ShingleRow {
  logical_file_id: string;
  shingle_hash: string;
  start_offset: number;
}

export function ComparisonView({ pair, fileA, fileB, onClose, onChanged }: Props) {
  const [texts, setTexts] = useState<Record<string, FileText>>({});
  const [matched, setMatched] = useState<{ a: string; b: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const showDiff = pair.confidence !== "metadata-only";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const ids = [fileA.id, fileB.id];
      const { data: textRows, error: textErr } = await supabase
        .from("logical_files_text")
        .select("logical_file_id, extracted_text, extraction_ok, extraction_reason, expected_min_chars, actual_chars")
        .in("logical_file_id", ids);
      if (textErr) {
        if (!cancelled) setError(textErr.message);
        return;
      }
      const map: Record<string, FileText> = {};
      for (const row of (textRows ?? []) as FileText[]) map[row.logical_file_id] = row;

      // Matched-sentence evidence via shingle start_offset (only if both have text).
      const evidence: { a: string; b: string }[] = [];
      if (showDiff && map[fileA.id]?.extracted_text && map[fileB.id]?.extracted_text) {
        const { data: shingles } = await supabase.rpc("get_file_shingles", {
          p_file_ids: ids,
        });
        const aOffsets = new Map<string, number>();
        const bOffsets = new Map<string, number>();
        for (const row of (shingles ?? []) as ShingleRow[]) {
          if (row.logical_file_id === fileA.id) aOffsets.set(row.shingle_hash, row.start_offset);
          else bOffsets.set(row.shingle_hash, row.start_offset);
        }
        const common = [...aOffsets.keys()].filter((h) => bOffsets.has(h));
        common.sort((x, y) => (aOffsets.get(x) ?? 0) - (aOffsets.get(y) ?? 0));
        for (const hash of common.slice(0, 2)) {
          evidence.push({
            a: excerpt(map[fileA.id].extracted_text!, aOffsets.get(hash) ?? 0),
            b: excerpt(map[fileB.id].extracted_text!, bOffsets.get(hash) ?? 0),
          });
        }
      }

      if (!cancelled) {
        setTexts(map);
        setMatched(evidence);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pair.id, fileA.id, fileB.id, showDiff]);

  async function dismiss() {
    setBusy(true);
    const { error } = await supabase
      .from("near_duplicate_pairs")
      .update({ status: "kept" })
      .eq("id", pair.id);
    setBusy(false);
    if (error) setError(error.message);
    else onChanged(true);
  }

  async function doDelete(fileId: string) {
    setBusy(true);
    setError(null);
    const { error } = await supabase.functions.invoke("delete-file", {
      body: { fileId },
    });
    setBusy(false);
    setConfirmDelete(null);
    if (error) setError(error.message);
    else onChanged(true);
  }

  async function doRename() {
    if (!renaming) return;
    const value = renaming.value.trim();
    if (!value) return;
    const stem = value.includes(".") ? value.slice(0, value.lastIndexOf(".")) : value;
    const ext = value.includes(".") ? value.slice(value.lastIndexOf(".") + 1).toLowerCase() : "";
    setBusy(true);
    const { error } = await supabase
      .from("logical_files")
      .update({ filename: value, filename_stem: stem, extension: ext })
      .eq("id", renaming.id);
    setBusy(false);
    setRenaming(null);
    if (error) setError(error.message);
    else onChanged(false);
  }

  const textA = texts[fileA.id];
  const textB = texts[fileB.id];

  return (
    <div className="overlay">
      <div className="card comparison">
        <div className="panel-head">
          <h2>Compare</h2>
          <button className="link" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="pair-head">
          <div>
            <strong>{fileA.filename}</strong>
            <div className="muted small">
              {formatBytes(fileA.size_bytes)} · {formatDate(fileA.uploaded_at)}
              {fileA.page_count != null && ` · ${fileA.page_count} page(s)`}
            </div>
          </div>
          <div className="score-block">
            <span className="score-big">{formatPercent(pair.composite_score)}</span>
            <span className={`conf conf-${pair.confidence}`}>
              {CONFIDENCE_LABEL[pair.confidence]}
            </span>
          </div>
          <div className="right">
            <strong>{fileB.filename}</strong>
            <div className="muted small">
              {formatBytes(fileB.size_bytes)} · {formatDate(fileB.uploaded_at)}
              {fileB.page_count != null && ` · ${fileB.page_count} page(s)`}
            </div>
          </div>
        </div>

        <p className="muted small">
          content score {pair.content_score === null ? "n/a" : formatPercent(pair.content_score)} ·
          filename score {formatPercent(pair.filename_score)} · composite{" "}
          {formatPercent(pair.composite_score)}
        </p>

        {error && <p className="error">{error}</p>}

        {loading ? (
          <p className="muted">Loading comparison…</p>
        ) : showDiff ? (
          <>
            <h3>Text diff (word-level)</h3>
            <div className="diff-box">
              {renderWordDiff(textA?.extracted_text ?? "", textB?.extracted_text ?? "")}
            </div>

            <h3>Matched passages</h3>
            {matched.length === 0 ? (
              <p className="muted">
                No shared 5-word shingle offsets were found between the two files.
              </p>
            ) : (
              matched.map((m, i) => (
                <div className="match-row" key={i}>
                  <div className="match-a">{m.a}</div>
                  <div className="match-b">{m.b}</div>
                </div>
              ))
            )}

            {pair.confidence === "provisional" && (
              <p className="muted small">
                Provisional: your library has fewer than 10 shingled files, so plain
                unweighted Jaccard was used instead of the down-weighted version.
              </p>
            )}
          </>
        ) : (
          <div className="metadata-only">
            <h3>Content diff unavailable</h3>
            <p className="muted">
              {textA?.extraction_reason ?? "Text could not be extracted"} for{" "}
              <strong>{fileA.filename}</strong>
              {textB && !textB.extraction_ok && (
                <>
                  {" "}and {textB.extraction_reason ?? "text could not be extracted"} for{" "}
                  <strong>{fileB.filename}</strong>
                </>
              )}
              . This pair was compared on filename and metadata only — no content
              comparison was possible, so no diff is shown.
            </p>
            <table className="deltas">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>{fileA.filename}</th>
                  <th>{fileB.filename}</th>
                  <th>Δ</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Size</td>
                  <td>{formatBytes(fileA.size_bytes)}</td>
                  <td>{formatBytes(fileB.size_bytes)}</td>
                  <td>{formatBytes(Math.abs(fileA.size_bytes - fileB.size_bytes))}</td>
                </tr>
                <tr>
                  <td>Uploaded</td>
                  <td>{formatDate(fileA.uploaded_at)}</td>
                  <td>{formatDate(fileB.uploaded_at)}</td>
                  <td>—</td>
                </tr>
                <tr>
                  <td>Pages</td>
                  <td>{fileA.page_count ?? "unknown"}</td>
                  <td>{fileB.page_count ?? "unknown"}</td>
                  <td>
                    {fileA.page_count != null && fileB.page_count != null
                      ? Math.abs(fileA.page_count - fileB.page_count)
                      : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <div className="actions">
          <button onClick={dismiss} disabled={busy}>
            Keep both (dismiss)
          </button>
          <button onClick={() => setRenaming({ id: fileA.id, value: fileA.filename })} disabled={busy}>
            Rename A
          </button>
          <button onClick={() => setRenaming({ id: fileB.id, value: fileB.filename })} disabled={busy}>
            Rename B
          </button>
          <button className="danger" onClick={() => setConfirmDelete(fileA.id)} disabled={busy}>
            Delete A
          </button>
          <button className="danger" onClick={() => setConfirmDelete(fileB.id)} disabled={busy}>
            Delete B
          </button>
        </div>

        {confirmDelete && (
          <div className="confirm">
            <p>
              Delete{" "}
              <strong>
                {confirmDelete === fileA.id ? fileA.filename : fileB.filename}
              </strong>
              ? This removes the logical file and decrements the shared blob's
              ref count. Stored bytes are only removed when no file references
              them.
            </p>
            <div className="actions">
              <button className="danger" onClick={() => doDelete(confirmDelete)} disabled={busy}>
                Yes, delete
              </button>
              <button onClick={() => setConfirmDelete(null)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {renaming && (
          <div className="confirm">
            <label>
              New filename
              <input
                value={renaming.value}
                onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
              />
            </label>
            <div className="actions">
              <button onClick={doRename} disabled={busy}>
                Save
              </button>
              <button onClick={() => setRenaming(null)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
