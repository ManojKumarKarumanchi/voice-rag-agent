"""
RAG module - FAISS-based vector store.
Supports PDF, CSV, TXT, MD file formats.
Uses pypdf for PDF and pandas for CSV.
"""

import os
import pickle
from pathlib import Path
from io import BytesIO

import numpy as np
from faiss import IndexFlatIP
from langchain_text_splitters import RecursiveCharacterTextSplitter
from sentence_transformers import SentenceTransformer

# Import parsers
try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None

try:
    import pandas as pd
except ImportError:
    pd = None


# Storage path
RAG_DIR = Path(__file__).resolve().parent / "rag_store"
RAG_DIR.mkdir(exist_ok=True)
INDEX_PATH = RAG_DIR / "index.faiss"
META_PATH = RAG_DIR / "meta.pkl"

print("Loading embedding model...")
embed_model = SentenceTransformer("BAAI/bge-small-en")
splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
print("Embedding model loaded")


def parse_pdf(file_content: bytes) -> str:
    """Extract text from PDF using pypdf."""
    if PdfReader is None:
        raise ImportError("pypdf is required. Install: pip install pypdf")

    try:
        reader = PdfReader(BytesIO(file_content))
        text_parts = []
        for i, page in enumerate(reader.pages):
            text = page.extract_text()
            if text and text.strip():
                text_parts.append(text)
            else:
                print(f"Warning: Page {i+1} has no extractable text")

        result = "\n\n".join(text_parts)
        print(f"PDF parsed successfully: {len(result)} characters extracted")
        return result
    except Exception as e:
        print(f"PDF parsing error: {e}")
        return ""


def parse_csv(file_content: bytes) -> str:
    """Extract text from CSV using pandas."""
    if pd is None:
        raise ImportError("pandas is required. Install: pip install pandas")

    try:
        df = pd.read_csv(BytesIO(file_content))
        text_parts = []
        for idx, row in df.iterrows():
            row_text = " | ".join([f"{col}: {val}" for col, val in row.items() if pd.notna(val)])
            if row_text:
                text_parts.append(row_text)
        result = "\n\n".join(text_parts)
        print(f"CSV parsed successfully: {len(result)} characters, {len(text_parts)} rows")
        return result
    except Exception as e:
        print(f"CSV parsing error: {e}")
        return file_content.decode("utf-8", errors="ignore")


def parse_file(file_content: bytes, filename: str) -> str:
    """Parse file content based on file extension."""
    ext = filename.lower().split(".")[-1] if "." in filename else ""

    print(f"Parsing file: {filename} (extension: {ext})")

    if ext == "pdf":
        return parse_pdf(file_content)
    elif ext == "csv":
        return parse_csv(file_content)
    else:
        # txt, md, or any text file
        return file_content.decode("utf-8", errors="ignore")


def _load_store():
    """Load FAISS index and metadata from disk."""
    if not INDEX_PATH.exists():
        return None, {"documents": [], "metadatas": []}

    index = _faiss_read(INDEX_PATH)
    meta = {"documents": [], "metadatas": []}

    if META_PATH.exists():
        with open(META_PATH, "rb") as f:
            meta = pickle.load(f)

    return index, meta


def _save_store(index, documents, metadatas):
    """Persist FAISS index and metadata."""
    _faiss_write(index, INDEX_PATH)
    with open(META_PATH, "wb") as f:
        pickle.dump({"documents": documents, "metadatas": metadatas}, f)


def _faiss_write(index, path):
    """Write FAISS index to file."""
    import faiss
    faiss.write_index(index, str(path))


def _faiss_read(path):
    """Read FAISS index from file."""
    import faiss
    return faiss.read_index(str(path))


def _l2_normalize(x: np.ndarray) -> np.ndarray:
    """L2 normalize for cosine similarity via inner product."""
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    return np.divide(x, norms, where=norms > 0)


def ingest_document(text: str, source: str) -> None:
    """Chunk text, embed, and add to vector store."""
    print(f"Ingesting document: {source}, text length: {len(text)}")

    if not text or not text.strip():
        print(f"Warning: No text content to ingest from {source}")
        return

    chunks = splitter.split_text(text)
    print(f"Split into {len(chunks)} chunks")

    if not chunks:
        print(f"Warning: No chunks created from {source}")
        return

    print("Generating embeddings...")
    embeddings = embed_model.encode(chunks, convert_to_numpy=True)
    embeddings = _l2_normalize(embeddings.astype(np.float32))
    print(f"Embeddings shape: {embeddings.shape}")

    metadatas = [{"source": source}] * len(chunks)

    index, meta = _load_store()
    if index is None:
        dim = embeddings.shape[1]
        index = IndexFlatIP(dim)
        meta = {"documents": [], "metadatas": []}

    index.add(embeddings)
    meta["documents"].extend(chunks)
    meta["metadatas"].extend(metadatas)

    _save_store(index, meta["documents"], meta["metadatas"])
    print(f"Document {source} indexed successfully. Total chunks: {len(meta['documents'])}")


def retrieve(query: str, k: int = 4):
    """Retrieve top-k similar chunks."""
    index, meta = _load_store()
    if index is None or not meta.get("documents"):
        return [], []

    q = embed_model.encode([query], convert_to_numpy=True)
    q = _l2_normalize(q.astype(np.float32))
    scores, indices = index.search(q, min(k, index.ntotal))

    docs = meta["documents"]
    metas = meta["metadatas"]
    out_docs = [docs[i] for i in indices[0] if 0 <= i < len(docs)]
    out_metas = [metas[i] if i < len(metas) else {"source": "unknown"} for i in indices[0] if 0 <= i < len(docs)]

    print(f"Retrieved {len(out_docs)} documents for query: {query[:50]}...")
    return out_docs, out_metas


def get_indexed_documents():
    """Get list of indexed document sources."""
    _, meta = _load_store()
    if not meta.get("documents"):
        return []

    sources = set()
    for m in meta.get("metadatas", []):
        if isinstance(m, dict) and m.get("source"):
            sources.add(m["source"])
    return list(sources)


def get_document_count():
    """Get total number of indexed documents/chunks."""
    _, meta = _load_store()
    return len(meta.get("documents", []))


def is_index_ready():
    """Check if the index has any documents."""
    _, meta = _load_store()
    return len(meta.get("documents", [])) > 0
