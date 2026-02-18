"""This is the backend server for the Voice RAG Agent demo."""

import os
import json
import logging
import uuid
import sys
from fastapi import FastAPI, UploadFile, File, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import uvicorn

load_dotenv()
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

_backend_dir = os.path.dirname(os.path.abspath(__file__))
_parent_dir = os.path.dirname(_backend_dir)
if _parent_dir not in sys.path:
    sys.path.insert(0, _parent_dir)

try:
    from backend.rag import (
        ingest_document,
        retrieve,
        parse_file,
        is_index_ready,
        get_indexed_documents,
        get_document_count,
    )
except ImportError:
    from rag import (
        ingest_document,
        retrieve,
        parse_file,
        is_index_ready,
        get_indexed_documents,
        get_document_count,
    )

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RetrieveRequest(BaseModel):
    """Request model for retrieval endpoint."""

    query: str
    k: int = 4


class TokenRequest(BaseModel):
    """Request model for token generation. Optional fields for participant info and metadata."""

    room_name: str = "voice-rag-room"
    participant_name: str = "User"
    participant_identity: str | None = None
    participant_metadata: str | None = None


@app.post("/getToken")
async def get_token(req: TokenRequest | None = Body(default=None)):
    """Generate LiveKit token for frontend connection and dispatch agent."""
    from livekit import api

    body = req.model_dump() if req is not None else {}
    # unique room name per session
    session_id = uuid.uuid4()
    room_name = f"voice-rag-{session_id}"
    participant_name = body.get("participant_name") or "User"
    participant_identity = f"user-{session_id}"
    participant_metadata = body.get("participant_metadata") or ""

    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")
    livekit_url = os.getenv("LIVEKIT_URL")
    if not all([api_key, api_secret, livekit_url]):
        raise HTTPException(500, "LiveKit credentials not configured")

    try:
        lk_api = api.LiveKitAPI(
            url=livekit_url,
            api_key=api_key,
            api_secret=api_secret,
        )

        room = await lk_api.room.create_room(
            api.CreateRoomRequest(
                name=room_name,
                empty_timeout=60,
            )
        )
        print(f"Room created: {room.name} (sid: {room.sid})")

        try:
            dispatch = await lk_api.agent_dispatch.create_dispatch(
                api.CreateAgentDispatchRequest(
                    room=room_name,
                    agent_name="voice-rag-agent",
                )
            )
            print(f"Agent dispatched: {dispatch.id}")
        except Exception as dispatch_err:
            print(f"Agent dispatch note: {dispatch_err}")

        await lk_api.aclose()
    except Exception as e:
        print(f"Room setup: {e}")

    token = (
        api.AccessToken(api_key=api_key, api_secret=api_secret)
        .with_identity(participant_identity)
        .with_name(participant_name)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
    )
    if participant_metadata:
        token = token.with_metadata(participant_metadata)

    return {
        "server_url": livekit_url,
        "participant_token": token.to_jwt(),
    }


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    """Upload a document, parse it, and ingest into FAISS index for RAG. (PDF, CSV, TXT, MD)"""
    content = await file.read()
    print(f"Upload request: {file.filename}, size: {len(content)} bytes")

    text = parse_file(content, file.filename)
    print(f"Parsed text length: {len(text)} characters")

    if not text or not text.strip():
        print("ERROR: No text content extracted!")
        return {"status": "error", "message": "Could not extract text from file."}

    ingest_document(text, file.filename)

    indexed_docs = get_indexed_documents()
    doc_count = get_document_count()

    print(f"Index status: {doc_count} chunks from {indexed_docs}")

    return {
        "status": "ingested",
        "filename": file.filename,
        "indexed_documents": indexed_docs,
        "total_chunks": doc_count,
        "message": f"{file.filename} has been indexed with {doc_count} chunks.",
    }


@app.get("/ragStatus")
def rag_status():
    """Get RAG index status."""
    ready = is_index_ready()
    docs = get_indexed_documents()
    count = get_document_count()

    if ready:
        message = f"Document is ready. {count} chunks indexed from: {', '.join(docs)}"
    else:
        message = "No documents indexed yet. Upload documents to enable RAG."

    return {
        "ready": ready,
        "indexed_documents": docs,
        "chunk_count": count,
        "message": message,
    }


@app.post("/retrieve")
async def retrieve_endpoint(req: RetrieveRequest):
    """Retrieve relevant documents from FAISS index based on query."""
    docs, sources = retrieve(req.query, req.k)
    return {"documents": docs, "metadatas": sources}


@app.get("/health")
def health():
    """Health check endpoint."""
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
