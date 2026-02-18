import { useState, useEffect } from "react";
import { uploadFile, getToken, getRagStatus } from "./api";
import VoiceRoom from "./VoiceRoom";

const DEFAULT_PROMPT = `
You are a professional, reliable voice assistant that answers questions strictly based on the uploaded documents in the knowledge base.

GENERAL BEHAVIOR:
- Greet the user politely.
- Maintain a professional, clear, and concise tone.
- Do NOT include jokes, humor, or unnecessary commentary.
- Do NOT add information that is not explicitly supported by the provided documents.

CONTEXT USAGE RULES:
- Use ONLY the retrieved context from the knowledge base to construct your answer.
- Do NOT rely on prior knowledge, assumptions, or external information.
- If the provided context does not contain sufficient information to answer the question, clearly state:
  "The provided documents do not contain enough information to answer this question."
- Do NOT hallucinate, fabricate, or infer beyond what is written in the documents.
- Do NOT speculate or guess.

CITATION REQUIREMENTS:
- Every factual statement must be supported by a citation from the retrieved documents.
- Always cite the exact source document and, if available, include section name, page number, or chunk reference.
- Use consistent citation formatting (e.g., [Document Name, Page X] or [Source ID]).
- Do not provide any answer without citations.

ANSWER FORMAT:
1. Polite greeting.
2. Direct answer supported strictly by citations.
3. Clear citations immediately following the relevant statements.
4. If information is missing, explicitly state that the documents do not contain the answer.

If multiple documents provide relevant information, cite all applicable sources.
`;

function App() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [uploadStatus, setUploadStatus] = useState("");
  const [connection, setConnection] = useState(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [ragReady, setRagReady] = useState(false);
  const [indexedDocs, setIndexedDocs] = useState([]);
  const [isIndexing, setIsIndexing] = useState(false);

  // Check RAG status on mount
  useEffect(() => {
    checkRagStatus();
  }, []);

  const checkRagStatus = async () => {
    try {
      const { data } = await getRagStatus();
      setRagReady(data.ready);
      setIndexedDocs(data.indexed_documents || []);
    } catch (err) {
      console.error("Failed to check RAG status:", err);
    }
  };

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsIndexing(true);
    setUploadStatus("Processing and indexing...");
    setError("");
    try {
      const { data } = await uploadFile(file);
      setUploadStatus(data.message || `✓ ${file.name} indexed successfully!`);
      setRagReady(true);
      setIndexedDocs(data.indexed_documents || []);
    } catch (err) {
      setUploadStatus("");
      setError(`Upload failed: ${err.response?.data?.detail || err.message}`);
    } finally {
      setIsIndexing(false);
    }
  };

  const handleStartCall = async () => {
    setConnecting(true);
    setError("");
    try {
      const { server_url, participant_token } = await getToken({
        roomName: "voice-rag-room",
        participantName: "User",
        systemPrompt: prompt,
      });
      setConnection({ token: participant_token, url: server_url });
    } catch (err) {
      setError(`Failed to connect: ${err.response?.data?.detail || err.message}`);
    } finally {
      setConnecting(false);
    }
  };

  const handleEndCall = () => {
    setConnection(null);
  };

  return (
    <div className="app">
      <div className="app__header">
        <h1 className="app__title">
          <span className="app__title-icon">🎙️</span>
          Voice RAG Agent - LiveKit by Manoj
        </h1>
        <p className="app__subtitle">
          Talk to an AI that answers from your documents in real-time
        </p>
      </div>

      <main className="app__main">
        <section className="card card--prompt">
          <h2 className="card__title">System Prompt</h2>
          <p className="card__hint">Customize how the agent responds</p>
          <textarea
            className="card__textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter system prompt..."
            rows={6}
          />
        </section>

        <section className="card card--upload">
          <h2 className="card__title">Knowledge Base</h2>
          <p className="card__hint">Upload .txt, .md, .csv, or .pdf documents</p>
          <label className="upload__zone">
            <input
              type="file"
              onChange={handleUpload}
              accept=".txt,.md,.csv,.pdf"
              className="upload__input"
              disabled={isIndexing}
            />
            <span className="upload__text">
              {isIndexing ? "Processing and indexing..." : (uploadStatus || "Choose file or drag here")}
            </span>
          </label>
          {ragReady && (
            <div className="rag-status rag-status--ready">
              <span className="rag-status__icon">&#10003;</span>
              <span className="rag-status__text">
                Document is ready. You can proceed with your queries. {indexedDocs.length} document(s) indexed: {indexedDocs.join(", ")}
              </span>
            </div>
          )}
          {!ragReady && (
            <div className="rag-status rag-status--empty">
              <span className="rag-status__text">No documents indexed yet. Upload documents to enable RAG.</span>
            </div>
          )}
        </section>

        <section className="card card--call">
          <h2 className="card__title">Voice Room</h2>
          {!connection ? (
            <>
              <p className="card__hint">
                Start a real-time voice call over WebRTC
              </p>
              <button
                className="btn btn--primary btn--lg"
                onClick={handleStartCall}
                disabled={connecting}
              >
                {connecting ? (
                  <>
                    <span className="btn__spinner" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <span>▶</span> Start Call
                  </>
                )}
              </button>
            </>
          ) : (
            <VoiceRoom
              token={connection.token}
              livekitUrl={connection.url}
              onEnd={handleEndCall}
            />
          )}
        </section>
      </main>

      {error && (
        <div className="toast toast--error" role="alert">
          {error}
        </div>
      )}

      <footer className="app__footer">
        <ol className="steps">
          <li>Upload documents to build your knowledge base</li>
          <li>Tweak the system prompt if needed</li>
          <li>Click Start Call and allow microphone access</li>
          <li>Ask questions — the agent answers using your docs</li>
        </ol>
      </footer>

      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; font-family: 'DM Sans', system-ui, sans-serif; background: #0f0f12; color: #e4e4e7; }
        .app { min-height: 100vh; padding: 2rem 1.5rem; max-width: 720px; margin: 0 auto; }
        .app__header { text-align: center; margin-bottom: 2.5rem; }
        .app__title { font-size: 1.75rem; font-weight: 700; margin: 0 0 0.5rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
        .app__title-icon { font-size: 1.5rem; }
        .app__subtitle { color: #a1a1aa; font-size: 0.95rem; margin: 0; }
        .app__main { display: flex; flex-direction: column; gap: 1.25rem; }
        .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 1.25rem 1.5rem; }
        .card__title { font-size: 1rem; font-weight: 600; margin: 0 0 0.25rem; }
        .card__hint { font-size: 0.8rem; color: #71717a; margin: 0 0 0.75rem; }
        .card__textarea { width: 100%; padding: 0.75rem; font-size: 0.9rem; background: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #e4e4e7; font-family: inherit; resize: vertical; min-height: 120px; }
        .card__textarea:focus { outline: none; border-color: #6366f1; }
        .upload__zone { display: flex; align-items: center; justify-content: center; padding: 1rem; background: #27272a; border: 2px dashed #3f3f46; border-radius: 8px; cursor: pointer; transition: border-color 0.2s; position: relative; z-index: 10; }
        .upload__zone:hover { border-color: #52525b; }
        .upload__input { position: absolute; width: 100%; height: 100%; opacity: 0; cursor: pointer; z-index: 20; }
        .upload__text { font-size: 0.9rem; color: #a1a1aa; pointer-events: none; }
        .rag-status { margin-top: 0.75rem; padding: 0.6rem 0.8rem; border-radius: 6px; font-size: 0.85rem; display: flex; align-items: center; gap: 0.5rem; }
        .rag-status--ready { background: #052e16; border: 1px solid #166534; color: #86efac; }
        .rag-status--empty { background: #27272a; border: 1px solid #3f3f46; color: #71717a; }
        .rag-status__icon { font-size: 1rem; }
        .btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 0.75rem 1.25rem; font-size: 1rem; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; transition: background 0.2s; font-family: inherit; position: relative; z-index: 10; pointer-events: auto; }
        .btn--primary { background: #6366f1; color: white; }
        .btn--primary:hover:not(:disabled) { background: #4f46e5; }
        .btn--primary:disabled { opacity: 0.7; cursor: not-allowed; }
        .btn--lg { padding: 1rem 1.5rem; font-size: 1.05rem; }
        .btn__spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 50%; animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .toast { position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%); padding: 0.75rem 1.25rem; border-radius: 8px; font-size: 0.9rem; max-width: 90%; z-index: 100; }
        .toast--error { background: #7f1d1d; color: #fecaca; border: 1px solid #991b1b; }
        .app__footer { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid #27272a; }
        .steps { margin: 0; padding-left: 1.25rem; color: #a1a1aa; font-size: 0.85rem; line-height: 1.8; }
      `}</style>
    </div>
  );
}

export default App;
