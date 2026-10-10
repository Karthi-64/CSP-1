import { useState } from "react";
import { supabase } from "../lib/supabase";
import { formatBytes, formatDate } from "../lib/format";
import type { LogicalFile } from "../lib/types";

interface Props {
  files: LogicalFile[];
  pendingCounts: Map<string, number>;
  onReviewFile: (fileId: string) => void;
  onChanged?: () => void;
}

export function FileList({ files, pendingCounts, onReviewFile, onChanged }: Props) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (files.length === 0) {
    return (
      <div className="card empty">
        No files yet. Upload a document to start building your library.
      </div>
    );
  }

  const sorted = [...files].sort(
    (a, b) => Date.parse(b.uploaded_at) - Date.parse(a.uploaded_at),
  );

  async function doDelete(fileId: string) {
    setBusy(true);
    setError(null);
    const { error } = await supabase.functions.invoke("delete-file", {
      body: { fileId },
    });
    setBusy(false);
    setConfirmDelete(null);
    if (error) setError(error.message);
    else onChanged?.();
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
    else onChanged?.();
  }

  return (
    <div className="card">
      {error && <p className="error">{error}</p>}
      <table className="file-table">
        <thead>
          <tr>
            <th>Filename</th>
            <th>Size</th>
            <th>Uploaded</th>
            <th>Flags</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((f) => {
            const shared = (f.physical_blobs?.ref_count ?? 1) > 1;
            const pending = pendingCounts.get(f.id) ?? 0;
            const isDeleting = confirmDelete === f.id;
            const isRenaming = renaming?.id === f.id;
            return (
              <tr key={f.id}>
                <td className="filename-cell">
                  {isRenaming ? (
                    <input
                      className="rename-input"
                      value={renaming.value}
                      autoFocus
                      disabled={busy}
                      onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void doRename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    f.filename
                  )}
                </td>
                <td>{formatBytes(f.size_bytes)}</td>
                <td>{formatDate(f.uploaded_at)}</td>
                <td className="flags-cell">
                  {shared && (
                    <span className="badge badge-tier1" title="Bytes are shared with other filenames">
                      Shared storage ×{f.physical_blobs?.ref_count}
                    </span>
                  )}
                  {pending > 0 && (
                    <button
                      className="badge badge-dup"
                      onClick={() => onReviewFile(f.id)}
                      title="Pending near-duplicate reviews involving this file"
                    >
                      {pending} possible dup{pending === 1 ? "" : "s"}
                    </button>
                  )}
                  {!shared && pending === 0 && <span className="muted">—</span>}
                </td>
                <td className="actions-cell">
                  {isDeleting ? (
                    <span className="row-confirm">
                      <button className="danger" onClick={() => void doDelete(f.id)} disabled={busy}>
                        Delete
                      </button>
                      <button onClick={() => setConfirmDelete(null)} disabled={busy}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="row-actions">
                      <button className="link" onClick={() => setRenaming({ id: f.id, value: f.filename })} disabled={busy}>
                        Rename
                      </button>
                      <button
                        className="link danger-link"
                        title="Delete this file"
                        onClick={() => setConfirmDelete(f.id)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
