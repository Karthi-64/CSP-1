import { formatBytes } from "../lib/format";

export interface DashboardStats {
  logicalFiles: number;
  physicalBlobs: number;
  uploadedBytes: number;
  storedBytes: number;
  pendingReviews: number;
}

export function Dashboard({ stats }: { stats: DashboardStats }) {
  const saved = Math.max(stats.uploadedBytes - stats.storedBytes, 0);
  const ratio = stats.storedBytes > 0 ? stats.uploadedBytes / stats.storedBytes : 1;

  return (
    <div className="stat-grid">
      <div className="card stat">
        <div className="stat-value">{stats.logicalFiles}</div>
        <div className="stat-label">Logical files</div>
      </div>
      <div className="card stat">
        <div className="stat-value">{stats.physicalBlobs}</div>
        <div className="stat-label">Physical blobs</div>
      </div>
      <div className="card stat">
        <div className="stat-value">{formatBytes(stats.uploadedBytes)}</div>
        <div className="stat-label">Bytes uploaded</div>
      </div>
      <div className="card stat">
        <div className="stat-value">{formatBytes(stats.storedBytes)}</div>
        <div className="stat-label">Bytes actually stored</div>
      </div>
      <div className="card stat">
        <div className="stat-value">{ratio.toFixed(2)}×</div>
        <div className="stat-label">Dedup ratio ({formatBytes(saved)} saved)</div>
      </div>
      <div className="card stat">
        <div className="stat-value">{stats.pendingReviews}</div>
        <div className="stat-label">Pending near-duplicate reviews</div>
      </div>
    </div>
  );
}
