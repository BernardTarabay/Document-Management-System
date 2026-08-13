/** Small label/value pair used throughout the file detail & edit modals. */
export function Field({ label, children }) {
  return (
    <div>
      <p className="label">{label}</p>
      <div className="text-base-100">{children}</div>
    </div>
  );
}
