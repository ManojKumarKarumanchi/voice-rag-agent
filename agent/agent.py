"""
Voice RAG Agent - LiveKit Agent Worker

This agent:
1. Listens for user speech via STT
2. Retrieves relevant context from RAG backend using on_user_turn_completed hook
3. Injects RAG context into the chat context
4. Generates LLM response
5. Speaks response via TTS

Based on LiveKit docs: https://docs.livekit.io/
"""

import asyncio
import json
import os
import requests
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    AutoSubscribe,
    JobContext,
    cli,
)
from livekit.agents.llm import ChatContext, ChatMessage
from livekit.plugins import silero

try:
    from livekit.agents import inference

    INFERENCE_AVAILABLE = True
    print(
        "LiveKit Inference available - can use Cartesia/ElevenLabs TTS with just LiveKit API key"
    )
except ImportError:
    INFERENCE_AVAILABLE = False
    print("LiveKit Inference not available")

# Fallback
try:
    from livekit.plugins import cartesia

    CARTESIA_PLUGIN_AVAILABLE = True
except ImportError:
    CARTESIA_PLUGIN_AVAILABLE = False
    cartesia = None

try:
    from livekit.plugins import groq

    GROQ_AVAILABLE = True
except ImportError:
    GROQ_AVAILABLE = False
    groq = None

load_dotenv()

DEFAULT_SYSTEM_PROMPT = """

You are a professional, reliable assistant that answers questions strictly based on the uploaded documents in the knowledge base.

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
Remember: Answer only from provided documents, concisely, with citations for every factual claim.
"""


def retrieve_context(query: str) -> dict:
    """Fetch relevant documents from the RAG backend."""
    try:
        base_url = os.getenv("RAG_BACKEND_URL", "http://localhost:8000")
        response = requests.post(
            f"{base_url}/retrieve", json={"query": query, "k": 4}, timeout=10
        )
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"RAG retrieve error: {e}")
        return {"documents": [], "metadatas": []}


def get_llm():
    """Get LLM - prefer LiveKit Inference, fallback to Groq plugin."""
    if INFERENCE_AVAILABLE:
        try:
            llm = inference.LLM("openai/gpt-4o-mini")
            print("LLM: LiveKit Inference (OpenAI gpt-4o-mini)")
            return llm
        except Exception as e:
            print(f"LiveKit Inference LLM failed: {e}")

    if GROQ_AVAILABLE:
        try:
            llm = groq.LLM(model="llama-3.3-70b-versatile")
            print("LLM: Groq plugin (llama-3.3-70b-versatile)")
            return llm
        except Exception as e:
            print(f"Groq LLM failed: {e}")

    raise RuntimeError("No LLM provider available!")


def get_stt():
    """Get STT - prefer LiveKit Inference, fallback to Groq plugin."""
    if INFERENCE_AVAILABLE:
        try:
            stt = inference.STT("deepgram/nova-3:en")
            print("STT: LiveKit Inference (Deepgram nova-3)")
            return stt
        except Exception as e:
            print(f"LiveKit Inference STT failed: {e}")

    if GROQ_AVAILABLE:
        try:
            stt = groq.STT(model="whisper-large-v3", language="en")
            print("STT: Groq plugin (whisper-large-v3)")
            return stt
        except Exception as e:
            print(f"Groq STT failed: {e}")

    raise RuntimeError("No STT provider available!")


def get_tts():
    """Get TTS - prefer LiveKit Inference, fallback to Cartesia plugin."""
    if INFERENCE_AVAILABLE:
        try:
            tts = inference.TTS("cartesia/sonic-2")
            print("TTS: LiveKit Inference (Cartesia sonic-2)")
            return tts
        except Exception as e:
            print(f"LiveKit Inference TTS failed: {e}")

    if CARTESIA_PLUGIN_AVAILABLE:
        try:
            tts = cartesia.TTS()
            print("TTS: Cartesia plugin")
            return tts
        except Exception as e:
            print(f"Cartesia TTS failed: {e}")

    print("TTS: Not available - agent will work in text-only mode")
    return None


class RAGAgent(Agent):
    """Voice agent with RAG capabilities using on_user_turn_completed hook."""

    def __init__(self, instructions: str, publish_rag_sources=None):
        super().__init__(
            instructions=instructions,
            llm=get_llm(),
        )
        self._publish_rag_sources = publish_rag_sources

    async def on_enter(self):
        """Called when agent becomes active - greet the user."""
        await self.session.generate_reply(
            instructions="Greet the user briefly and let them know you can answer questions about their uploaded documents.",
        )

    async def on_user_turn_completed(
        self, turn_ctx: ChatContext, new_message: ChatMessage
    ) -> None:
        """Called when user's turn ends, before agent responds."""
        # Get the user's message text
        user_query = (
            new_message.text_content if hasattr(new_message, "text_content") else ""
        )
        if callable(user_query):
            user_query = user_query()

        if not user_query:
            print("No user query to process for RAG")
            return

        print(f"RAG lookup for: {user_query[:100]}...")

        rag_result = retrieve_context(user_query)
        docs = rag_result.get("documents", []) or []
        metadatas = rag_result.get("metadatas", []) or []

        print(f"Retrieved {len(docs)} RAG documents")

        if self._publish_rag_sources and docs:
            try:
                sources_payload = json.dumps(
                    {
                        "documents": docs,
                        "sources": [
                            (
                                m.get("source", "unknown")
                                if isinstance(m, dict)
                                else "unknown"
                            )
                            for m in metadatas
                        ],
                    }
                )
                await self._publish_rag_sources(sources_payload)
            except Exception as e:
                print(f"Error publishing RAG sources: {e}")

        if docs:
            context = "\n\n---\n\n".join(docs)
            turn_ctx.add_message(
                role="assistant",
                content=f"Here is relevant context from the knowledge base to help answer the user's question:\n\n{context}",
            )
            print("Injected RAG context into chat")
        else:
            turn_ctx.add_message(
                role="assistant",
                content="No relevant context was found in the knowledge base for this question.",
            )


server = AgentServer()


@server.rtc_session(agent_name="voice-rag-agent")
async def entrypoint(ctx: JobContext):
    """RTC session entrypoint."""
    print("Agent entrypoint starting...")

    try:
        await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
        print(f"Connected to room: {ctx.room.name}")

        # Reconnection event handlers
        def handle_reconnecting():
            print("Room reconnecting...")

        def handle_reconnected():
            print("Room reconnected successfully!")

        def handle_disconnected(reason=None):
            print(f"Room disconnected: {reason}")

        def handle_connection_state_changed(state):
            print(f"Connection state changed: {state}")

        ctx.room.on("reconnecting", handle_reconnecting)
        ctx.room.on("reconnected", handle_reconnected)
        ctx.room.on("disconnected", handle_disconnected)
        ctx.room.on("connection_state_changed", handle_connection_state_changed)

    except Exception as e:
        print(f"Connection error: {e}")
        raise

    participant = await ctx.wait_for_participant()
    print(f"Participant joined: {participant.identity}")

    system_prompt = DEFAULT_SYSTEM_PROMPT
    if participant.metadata:
        try:
            meta = json.loads(participant.metadata)
            if meta.get("system_prompt"):
                system_prompt = meta["system_prompt"]
                print("Using custom system prompt from metadata")
        except (json.JSONDecodeError, TypeError):
            pass

    async def publish_rag_sources(payload: str):
        try:
            if ctx.room.isconnected():
                await ctx.room.local_participant.publish_data(
                    payload.encode(),
                    topic="rag_sources",
                )
                print("Published RAG sources")
            else:
                print("Room not connected, skipping RAG sources publish")
        except Exception as e:
            print(f"RAG sources publish error: {e}")

    agent = RAGAgent(
        instructions=system_prompt,
        publish_rag_sources=publish_rag_sources,
    )

    tts = get_tts()

    print("Creating agent session...")
    session = AgentSession(vad=silero.VAD.load(), stt=get_stt(), tts=tts)

    def on_state_changed(evt):
        state = getattr(evt, "new_state", str(evt))
        print(f"Agent state: {state}")

        async def _update_attrs():
            try:
                if ctx.room.isconnected():
                    await ctx.room.local_participant.set_attributes(
                        {"lk.agent.state": str(state)}
                    )
            except Exception as e:
                print(f"Could not set state attribute: {e}")

        asyncio.create_task(_update_attrs())

    session.on("agent_state_changed", on_state_changed)

    def on_user_transcribed(evt):
        transcript = getattr(evt, "transcript", "")
        is_final = getattr(evt, "is_final", True)

        if transcript and is_final:
            print(f"User: {transcript}")

            async def _publish():
                try:
                    if ctx.room.isconnected():
                        await ctx.room.local_participant.publish_data(
                            f"USER:{transcript}".encode(),
                            topic="transcript",
                        )
                except Exception as e:
                    print(f"Transcript publish error: {e}")

            asyncio.create_task(_publish())

    session.on("user_input_transcribed", on_user_transcribed)

    def on_conversation_item(evt):
        item = evt.item
        role = getattr(item, "role", "unknown")
        text = ""

        if hasattr(item, "text_content"):
            text = item.text_content
            if callable(text):
                text = text()

        if role == "assistant" and text:
            print(f"Agent: {text[:100]}...")

            async def _publish():
                try:
                    if ctx.room.isconnected():
                        await ctx.room.local_participant.publish_data(
                            f"BOT:{text}".encode(),
                            topic="transcript",
                        )
                except Exception as e:
                    print(f"Agent transcript error: {e}")

            asyncio.create_task(_publish())

    session.on("conversation_item_added", on_conversation_item)

    print("Starting agent session...")
    await session.start(
        room=ctx.room,
        agent=agent,
    )
    print("Agent session started!")

    await asyncio.Event().wait()


if __name__ == "__main__":
    cli.run_app(server)
