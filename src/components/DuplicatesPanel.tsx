import { formatPercent } from "../lib/format";
import { CONFIDENCE_LABEL, type LogicalFile, type NearDuplicatePair } from "../lib/types";

interface Props {
  pairs: NearDuplicatePair[];
  filesById: Map<string, LogicalFile>;
  filterFileId: string | null;
  onClearFilter: () => void;
  onOpen: (pairId: string) => void;
}

export function DuplicatesPanel({
  pairs,
  filesById,
  filterFileId,
  onClearFilter,
  onOpen,
}: Props) {
  const visible = filterFileId
    ? pairs.filter((p) => p.file_a_id === filterFileId || p.file_b_id === filterFileId)
    : pairs;

  return (
    <div className="card">
      <div className="panel-head">
        <h2>Possible duplicates</h2>
        {filterFileId && (
          <button className="link" onClick={onClearFilter}>
            Clear file filter
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="muted empty">
          No pending reviews. Nothing has crossed the similarity thresholds yet.
        </p>
      ) : (
        <table className="dup-table">
          <thead>
            <tr>
              <th>File A</th>
              <th>File B</th>
              <th>Match</th>
              <th>Confidence</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const a = filesById.get(p.file_a_id);
              const b = filesById.get(p.file_b_id);
              return (
                <tr key={p.id}>
                  <td>{a?.filename ?? "(deleted)"}</td>
                  <td>{b?.filename ?? "(deleted)"}</td>
                  <td className="score">{formatPercent(p.composite_score)}</td>
                  <td>
                    <span className={`conf conf-${p.confidence}`}>
                      {CONFIDENCE_LABEL[p.confidence]}
                    </span>
                  </td>
                  <td>
                    <button onClick={() => onOpen(p.id)}>Compare</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
