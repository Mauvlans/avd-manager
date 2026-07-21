import { useState } from "react";
import { listAuditLog, AuditLogRow } from "../lib/api";
import { useTenantId } from "../lib/useTenantId";

export default function AuditLog() {
  const [tenantId] = useTenantId();
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  async function refresh() {
    setError("");
    try {
      setRows(await listAuditLog(tenantId, 100));
      setLoaded(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!tenantId) return <p className="warn">No tenant selected. Complete onboarding first.</p>;

  return (
    <div>
      <h1>Audit Log</h1>
      {error && <p className="err">{error}</p>}
      <button onClick={refresh}>{loaded ? "Refresh" : "Load audit log"}</button>
      {rows.length > 0 && (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Resource</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.created_at).toLocaleString()}</td>
                <td>{r.actor}</td>
                <td>{r.action}</td>
                <td>{r.resource_type}/{r.resource_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
