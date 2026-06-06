export default function App() {
  const error = "Error: VisualStruct fetch failed: This operation was aborted";
  const imageUrl = "https://cdn.codia.ai/projects/d6068880-120b-400d-b75b-4eb024cce8ec/resource/opendeepsea.png";
  return (
    <div style={{ minHeight: '100vh', padding: 16, fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <h1 style={{ fontSize: 16, margin: 0, fontWeight: 700 }}>Strict DSL replication blocked</h1>
        <p style={{ marginTop: 8, marginBottom: 0, fontSize: 13, color: '#444' }}>
          VisualStruct failed; cannot deterministically validate or replicate from DSL.
        </p>
        <pre style={{ marginTop: 12, padding: 12, background: '#f6f6f6', borderRadius: 8, overflowX: 'auto', fontSize: 12 }}>
{error}
        </pre>
        {imageUrl ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Input image</div>
            <img src={imageUrl} alt="input" style={{ maxWidth: '100%', height: 'auto', borderRadius: 12, border: '1px solid #eee' }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
