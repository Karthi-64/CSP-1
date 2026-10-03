import { formatBytes, formatDate } from "../lib/format";
import type { LogicalFile } from "../lib/types";

interface Props {
  files: LogicalFile[];
  pendingCounts: Map<string, number>;
  onReviewFile: (fileId: string) => void;
}

export function FileList({ files, pendingCounts, onReviewFile }: Props) {
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

  return (
    <div className="card">
      <table className="file-table">
        <thead>
          <tr>
            <th>Filename</th>
            <th>Size</th>
            <th>Uploaded</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((f) => {
            const shared = (f.physical_blobs?.ref_count ?? 1) > 1;
            const pending = pendingCounts.get(f.id) ?? 0;
            return (
              <tr key={f.id}>
                <td className="filename-cell">{f.filename}</td>
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
