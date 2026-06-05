from groq import Groq
from fastapi import FastAPI, WebSocket, Body, UploadFile, File, Form, HTTPException, Header, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import os
from dotenv import load_dotenv
import json
from uuid import uuid4
import hashlib
import secrets
import time
from typing import Optional
from database import (
    init_db,
    save_message,
    get_chat_history,
    build_prompt,
    chat_exists,
    create_chat_with_title,
    delete_chat,
    rename_chat,
    get_chat_info,
    get_user_chats,
    add_document,
    get_documents,
    get_document,
    get_document_by_hash,
    delete_document_record,
    get_all_document_hashes,
)

from langchain_classic.chains import create_history_aware_retriever, create_retrieval_chain
from langchain_classic.chains.combine_documents import create_stuff_documents_chain
from langchain_core.chat_history import BaseChatMessageHistory
from langchain_community.chat_message_histories import ChatMessageHistory
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables.history import RunnableWithMessageHistory
from langchain_community.vectorstores import FAISS
from langchain_community.document_loaders import PyPDFLoader, Docx2txtLoader, TextLoader
from langchain_core.embeddings import Embeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_groq import ChatGroq
import requests
import tempfile
import traceback


load_dotenv()
app = FastAPI()

# Use persistent storage if available (Fly.io volume mounted at /app/data)
DATA_DIR = os.getenv("DATA_DIR", "/app/data" if os.path.exists("/app/data") else ".")
os.makedirs(DATA_DIR, exist_ok=True)

client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# ============================================================
# Admin Authentication (simple token-based for KB management)
# ============================================================

ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "mube-admin-2024")
admin_tokens = {}  # {token: expiry_timestamp}
TOKEN_EXPIRY_SECONDS = 24 * 60 * 60  # 24 hours


def verify_admin_token(authorization: Optional[str] = Header(None)) -> bool:
    """Dependency that verifies admin auth token from Authorization header."""
    if not authorization:
        raise HTTPException(status_code=401, detail="Admin authentication required")
    
    token = authorization.replace("Bearer ", "").strip()
    if not token or token not in admin_tokens:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    
    # Check expiry
    if time.time() > admin_tokens[token]:
        del admin_tokens[token]
        raise HTTPException(status_code=401, detail="Token expired, please login again")
    
    return True


class HFInferenceEmbeddings(Embeddings):
    """Direct HuggingFace Inference API embeddings — bypasses broken langchain wrapper."""

    def __init__(self, api_key: str, model_name: str = "sentence-transformers/all-MiniLM-L6-v2"):
        if not api_key:
            raise ValueError("HUGGINGFACEHUB_API_TOKEN is missing. Please set it in your .env file.")
        self.api_urls = [
            f"https://router.huggingface.co/hf-inference/models/{model_name}/pipeline/feature-extraction",
            f"https://api-inference.huggingface.co/models/{model_name}",
        ]
        self.headers = {"Authorization": f"Bearer {api_key}"}

    def _query(self, texts: list) -> list:
        payload = {"inputs": texts, "options": {"wait_for_model": True}}
        last_error = None

        for api_url in self.api_urls:
            try:
                response = requests.post(
                    api_url,
                    headers=self.headers,
                    json=payload,
                    timeout=30,
                )
                response.raise_for_status()
                result = response.json()
                if isinstance(result, dict) and "error" in result:
                    raise ValueError(f"HuggingFace API error from {api_url}: {result['error']}")
                return result
            except requests.exceptions.RequestException as exc:
                last_error = exc
                continue

        raise ValueError(
            "Failed to reach Hugging Face inference endpoints. "
            f"Last error: {last_error}"
        )

    def embed_documents(self, texts: list) -> list:
        return self._query(texts)

    def embed_query(self, text: str) -> list:
        result = self._query([text])
        return result[0]


# Lazy load embeddings — only created when first document is uploaded
_embeddings = None

def get_embeddings():
    global _embeddings
    if _embeddings is None:
        _embeddings = HFInferenceEmbeddings(
            api_key=os.getenv("HUGGINGFACEHUB_API_TOKEN"),
        )
    return _embeddings

# LLM for langchain RAG
llm = ChatGroq(model="llama-3.1-8b-instant", temperature=0.2)

# Session stores (for RAG conversation memory)
session_store = {}

# ============================================================
# Persistent Knowledge Base (Single global vector store)
# ============================================================

KNOWLEDGE_BASE_PATH = os.path.join(DATA_DIR, "vectors/knowledge_base")
KB_UPLOADS_PATH = os.path.join(DATA_DIR, "uploads/knowledge_base")
_global_vectorstore = None

def get_knowledge_base_path():
    """Get the path for the persistent knowledge base index."""
    os.makedirs(os.path.join(DATA_DIR, "vectors"), exist_ok=True)
    return KNOWLEDGE_BASE_PATH


def get_kb_uploads_path():
    """Get the path for permanently stored KB uploads."""
    os.makedirs(KB_UPLOADS_PATH, exist_ok=True)
    return KB_UPLOADS_PATH


def load_global_vectorstore():
    """Load the global vector store from disk, or return None if it doesn't exist."""
    global _global_vectorstore
    kb_path = get_knowledge_base_path()
    if os.path.exists(kb_path) and os.path.isdir(kb_path):
        try:
            vectorstore = FAISS.load_local(
                kb_path,
                get_embeddings(),
                allow_dangerous_deserialization=True
            )
            _global_vectorstore = vectorstore
            print(f"Loaded knowledge base from disk ({vectorstore.index.ntotal} vectors)")
            return vectorstore
        except Exception as e:
            print(f"Could not load knowledge base: {e}")
    return None


def save_global_vectorstore():
    """Save the global vector store to disk."""
    global _global_vectorstore
    if _global_vectorstore is not None:
        kb_path = get_knowledge_base_path()
        os.makedirs(kb_path, exist_ok=True)
        _global_vectorstore.save_local(kb_path)
        print(f"Saved knowledge base to disk ({_global_vectorstore.index.ntotal} vectors)")


def get_global_vectorstore():
    """Get the global vector store, loading it if needed."""
    global _global_vectorstore
    if _global_vectorstore is None:
        _global_vectorstore = load_global_vectorstore()
    return _global_vectorstore


def knowledge_base_has_documents() -> bool:
    """Check if the knowledge base has any documents."""
    vs = get_global_vectorstore()
    if vs is not None:
        try:
            return vs.index.ntotal > 0
        except Exception:
            return False
    return False


def retrieve_from_knowledge_base(query: str, k: int = 4) -> list:
    """Retrieve relevant chunks from the persistent knowledge base.
    
    Returns:
        List of document text strings.
    """
    vs = get_global_vectorstore()
    if vs is None:
        return []
    
    try:
        docs = vs.similarity_search(query, k=k)
        return [doc.page_content for doc in docs]
    except Exception as e:
        print(f"Error retrieving from knowledge base: {e}")
        return []


# ============================================================
# EPUB Document Loader
# ============================================================

def load_epub(file_path: str) -> list:
    """Load an EPUB file and return a list of LangChain Document objects.
    
    Uses EBookLib to parse the EPUB and extract text from each chapter.
    """
    try:
        import ebooklib
        from ebooklib import epub
        from bs4 import BeautifulSoup
    except ImportError:
        raise ImportError("EbookLib and BeautifulSoup are required for EPUB support. Install with: pip install EbookLib beautifulsoup4")

    book = epub.read_epub(file_path)
    documents = []
    
    for item in book.get_items():
        if item.get_type() == ebooklib.ITEM_DOCUMENT:
            # Parse the HTML content
            soup = BeautifulSoup(item.get_content(), 'html.parser')
            
            # Remove script and style elements
            for script in soup(["script", "style"]):
                script.decompose()
            
            text = soup.get_text(separator='\n')
            
            # Clean up whitespace
            lines = [line.strip() for line in text.split('\n') if line.strip()]
            clean_text = '\n'.join(lines)
            
            if clean_text.strip():
                from langchain_core.documents import Document
                documents.append(Document(
                    page_content=clean_text,
                    metadata={"source": item.get_name() or "unknown"}
                ))
    
    return documents


def get_file_hash(file_content: bytes) -> str:
    """Calculate MD5 hash of file content."""
    return hashlib.md5(file_content).hexdigest()


def get_session_history(session_id: str) -> BaseChatMessageHistory:
    """Get or create chat message history for a session."""
    if session_id not in session_store:
        session_store[session_id] = ChatMessageHistory()
    return session_store[session_id]


@app.on_event("startup")
async def startup_event():
    """Initialize database and load knowledge base on app startup."""
    init_db()
    load_global_vectorstore()
    print(f"Knowledge base status: {'loaded' if knowledge_base_has_documents() else 'empty'}")


@app.post("/admin/login")
async def admin_login(body: dict = Body(...)):
    """Authenticate admin and return a token for KB management."""
    password = body.get("password", "")
    
    if not secrets.compare_digest(password, ADMIN_PASSWORD):
        return JSONResponse(
            status_code=401,
            content={"error": "Invalid password"}
        )
    
    # Generate a token that expires in 24 hours
    token = secrets.token_urlsafe(32)
    admin_tokens[token] = time.time() + TOKEN_EXPIRY_SECONDS
    
    return {
        "token": token,
        "message": "Admin authenticated successfully",
        "expires_in": TOKEN_EXPIRY_SECONDS,
    }


@app.post("/admin/logout")
async def admin_logout(authorization: Optional[str] = Header(None)):
    """Invalidate admin token."""
    if authorization:
        token = authorization.replace("Bearer ", "").strip()
        admin_tokens.pop(token, None)
    return {"message": "Logged out"}


@app.get("/")
async def get_home():
    return FileResponse("templates/index.html")


@app.post("/new_chat")
async def new_chat(body: dict = Body(...)):
    """Generate a new chat_id for a user."""
    user_id = body.get("user_id")
    
    if not user_id:
        return {"error": "user_id is required"}
    
    chat_id = str(uuid4())
    return {"chat_id": chat_id}


@app.get("/chats/{user_id}")
async def get_chats(user_id: str):
    """Get list of chats for a user that have messages, with titles."""
    chats = get_user_chats(user_id)
    return chats


@app.get("/chat/{chat_id}")
async def get_chat(chat_id: str):
    """Get all messages for a specific chat."""
    from database import get_chat_history
    history = get_chat_history(chat_id)
    return history


@app.delete("/chat/{chat_id}")
async def delete_chat_endpoint(chat_id: str):
    """Delete a chat and all its messages."""
    delete_chat(chat_id)
    return {"status": "deleted"}


@app.put("/chat/{chat_id}/rename")
async def rename_chat_endpoint(chat_id: str, body: dict = Body(...)):
    """Rename a chat."""
    new_title = body.get("title", "").strip()
    
    if not new_title:
        return {"error": "Title cannot be empty"}
    
    success = rename_chat(chat_id, new_title)
    
    if not success:
        return {"error": "Chat not found"}
    
    chat_info = get_chat_info(chat_id)
    return chat_info


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_text()
            message_data = json.loads(data)
            chat_id = message_data.get("chat_id")
            user_id = message_data.get("user_id")
            user_content = message_data.get("content")

            if not chat_id or not user_id or not user_content:
                await websocket.send_text(
                    json.dumps(
                        {"type": "error", "content": "Missing chat_id, user_id, or content"}
                    )
                )
                continue

            # Create chat on first message if it doesn't exist
            if not chat_exists(chat_id):
                create_chat_with_title(chat_id, user_id, user_content)

            # Save user message to database
            save_message(chat_id, "user", user_content)

            # Retrieve relevant context from the persistent knowledge base (if it has documents)
            context_chunks = []
            if knowledge_base_has_documents():
                context_chunks = retrieve_from_knowledge_base(user_content, k=4)
                if context_chunks:
                    print(f"[KB] Retrieved {len(context_chunks)} context chunks for query: {user_content[:80]}...")
                else:
                    print(f"[KB] No chunks retrieved (vectorstore exists but similarity search returned empty). Query: {user_content[:80]}...")
            else:
                print(f"[KB] Knowledge base has no documents. Query processed without KB context.")

            # Build prompt with knowledge base context
            chat_log = build_prompt(chat_id, user_content, context_chunks=context_chunks if context_chunks else None)

            # Get response from Groq API
            response = client.chat.completions.create(
                model="llama-3.1-8b-instant",
                messages=chat_log,
                temperature=0.5,
                top_p=0.9,
                max_tokens=1000,
                stream=True,
            )

            # Stream and collect response
            full_response = ""
            for chunk in response:
                if chunk.choices[0].delta.content:
                    full_response += chunk.choices[0].delta.content
                    await websocket.send_text(
                        json.dumps({"type": "stream", "content": chunk.choices[0].delta.content})
                    )

            # Save assistant message to database
            save_message(chat_id, "assistant", full_response)
            await websocket.send_text(json.dumps({"type": "complete"}))

    except Exception as e:
        await websocket.send_text(json.dumps({"type": "error", "content": str(e)}))


# ============================================================
# Persistent Knowledge Base - Admin Endpoints
# ============================================================

@app.get("/kb/status")
async def kb_status():
    """Get knowledge base status (public - used during chat to check if KB exists)."""
    vs = get_global_vectorstore()
    doc_count = 0
    chunk_count = 0
    if vs is not None:
        try:
            chunk_count = vs.index.ntotal
        except Exception:
            pass
    
    documents = get_documents()
    doc_count = len(documents)
    
    return {
        "document_count": doc_count,
        "chunk_count": chunk_count,
        "documents": documents,
        "has_documents": knowledge_base_has_documents(),
    }


@app.get("/kb/debug")
async def kb_debug():
    """Debug endpoint to check KB retrieval status (admin only)."""
    vs = get_global_vectorstore()
    info = {
        "vectorstore_loaded": vs is not None,
        "vectorstore_path": KNOWLEDGE_BASE_PATH,
        "vectorstore_exists_on_disk": os.path.exists(KNOWLEDGE_BASE_PATH),
        "uploads_path": KB_UPLOADS_PATH,
        "uploads_exists": os.path.exists(KB_UPLOADS_PATH),
    }
    
    if vs is not None:
        try:
            info["total_vectors"] = vs.index.ntotal
        except Exception as e:
            info["total_vectors_error"] = str(e)
    
    # List files in uploads
    uploads_path = get_kb_uploads_path()
    if os.path.exists(uploads_path):
        info["uploaded_files"] = os.listdir(uploads_path)
    else:
        info["uploaded_files"] = []
    
    # List files in vectors dir
    vectors_dir = os.path.join(DATA_DIR, "vectors")
    if os.path.exists(vectors_dir):
        info["vector_files"] = os.listdir(vectors_dir)
    else:
        info["vector_files"] = []
    
    # Test a sample retrieval
    try:
        if vs is not None:
            docs = vs.similarity_search("test", k=2)
            info["sample_retrieval"] = {"count": len(docs), "preview": docs[0].page_content[:200] if docs else "none"}
    except Exception as e:
        info["sample_retrieval_error"] = str(e)
    
    return info


@app.post("/kb/upload")
async def kb_upload(file: UploadFile = File(...), _admin: bool = Depends(verify_admin_token)):
    """Upload a document to the persistent knowledge base.
    
    Supports: PDF, DOCX, TXT, EPUB
    Files are deduplicated by content hash.
    New files are merged into the existing knowledge base index.
    """
    print(f"Received document for knowledge base: {file.filename}")
    os.makedirs(os.path.join(DATA_DIR, "temp_uploads"), exist_ok=True)
    os.makedirs(os.path.join(DATA_DIR, "vectors"), exist_ok=True)

    # Check file type
    file_ext = file.filename.lower().split('.')[-1]
    allowed_extensions = ['pdf', 'docx', 'txt', 'epub']
    
    if file_ext not in allowed_extensions:
        return JSONResponse(
            status_code=400, 
            content={"error": f"Only {', '.join(allowed_extensions).upper()} files are allowed."}
        )

    # Read file content
    file_content = await file.read()
    
    # Calculate file hash for deduplication
    file_hash = get_file_hash(file_content)
    
    # Check if we've already uploaded this file
    existing_doc = get_document_by_hash(file_hash)
    if existing_doc:
        return JSONResponse(
            status_code=409,
            content={
                "error": "This file has already been uploaded.",
                "existing_document": existing_doc
            }
        )

    # Save uploaded file permanently for rebuild capability
    permanent_location = os.path.join(get_kb_uploads_path(), f"{file_hash}_{file.filename}")
    with open(permanent_location, "wb") as f:
        f.write(file_content)

    try:
        # Load document based on file type
        if file_ext == 'pdf':
            loader = PyPDFLoader(permanent_location)
        elif file_ext == 'docx':
            loader = Docx2txtLoader(permanent_location)
        elif file_ext == 'txt':
            loader = TextLoader(permanent_location, encoding='utf-8')
        elif file_ext == 'epub':
            documents = load_epub(permanent_location)
            # Skip the regular loader path for EPUB
            if not documents:
                return JSONResponse(
                    status_code=500,
                    content={"error": "Failed to extract text from EPUB file."}
                )
        else:
            return JSONResponse(
                status_code=400,
                content={"error": f"Unsupported file type: {file_ext}"}
            )
        
        # For non-EPUB files, use the loader
        if file_ext != 'epub':
            documents = loader.load()
        
        # Add filename to metadata for tracking
        for doc in documents:
            doc.metadata['source_filename'] = file.filename
        
        # Split into text chunks
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        splits = text_splitter.split_documents(documents)
        
        chunk_count = len(splits)
        print(f"Split {file.filename} into {chunk_count} chunks")
        
        # Check if knowledge base already exists
        existing_vs = get_global_vectorstore()
        
        if existing_vs is not None:
            # MERGE: Add new document to existing knowledge base
            print(f"Merging {file.filename} into existing knowledge base")
            new_vectorstore = FAISS.from_documents(splits, get_embeddings())
            existing_vs.merge_from(new_vectorstore)
            save_global_vectorstore()
            merged = True
        else:
            # FIRST DOCUMENT: Create new knowledge base
            print(f"Creating new knowledge base with {file.filename}")
            _global_vectorstore = FAISS.from_documents(splits, get_embeddings())
            save_global_vectorstore()
            merged = False
        
        # Record document in database (store the permanent file path as well)
        doc_id = add_document(file.filename, file_hash, file_ext.upper(), chunk_count)
        
        print(f"Successfully processed {file.filename} for knowledge base")
        return {
            "message": "Document added to knowledge base successfully",
            "filename": file.filename,
            "file_type": file_ext.upper(),
            "chunk_count": chunk_count,
            "document_id": doc_id,
            "merged": merged,
            "total_chunks": _global_vectorstore.index.ntotal if _global_vectorstore else chunk_count,
        }

    except Exception as e:
        print(f"Error processing document: {str(e)}")
        print(traceback.format_exc())
        # Clean up permanent file on error
        if os.path.exists(permanent_location):
            os.remove(permanent_location)
        return JSONResponse(status_code=500, content={"error": str(e)})


# ============================================================
# Feedback Endpoint
# ============================================================

@app.post("/feedback")
async def submit_feedback(body: dict = Body(...)):
    """Store user feedback on a bot response."""
    user_id = body.get("user_id")
    chat_id = body.get("chat_id")
    message_index = body.get("message_index", -1)
    feedback = body.get("feedback")  # "positive" or "negative"

    if not user_id or not chat_id or feedback not in ("positive", "negative"):
        return JSONResponse(
            status_code=400,
            content={"error": "user_id, chat_id, and valid feedback are required."}
        )

    # Append feedback to a JSON-lines log file
    feedback_dir = os.path.join(DATA_DIR, "feedback")
    os.makedirs(feedback_dir, exist_ok=True)
    feedback_file = os.path.join(feedback_dir, "feedback.jsonl")

    entry = {
        "user_id": user_id,
        "chat_id": chat_id,
        "message_index": message_index,
        "feedback": feedback,
    }

    try:
        with open(feedback_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        return {"status": "recorded"}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/kb/document/{doc_id}")
async def kb_delete_document(doc_id: int, _admin: bool = Depends(verify_admin_token)):
    """Delete a document from the knowledge base and rebuild the index from remaining docs."""
    global _global_vectorstore
    
    # Get the document record
    doc = get_document(doc_id)
    if not doc:
        return JSONResponse(
            status_code=404,
            content={"error": "Document not found"}
        )
    
    # Remove the permanently stored file
    kb_uploads = get_kb_uploads_path()
    stored_files = [f for f in os.listdir(kb_uploads) if f.startswith(doc['file_hash'] + '_')]
    for stored_file in stored_files:
        file_path = os.path.join(kb_uploads, stored_file)
        if os.path.exists(file_path):
            os.remove(file_path)
    
    # Delete the database record
    delete_document_record(doc_id)
    
    # Rebuild the entire knowledge base from remaining documents
    remaining_docs = get_documents()
    
    if not remaining_docs:
        # No documents left - clear the vector store
        _global_vectorstore = None
        kb_path = get_knowledge_base_path()
        if os.path.exists(kb_path):
            import shutil
            shutil.rmtree(kb_path)
        
        return {
            "message": f"Deleted '{doc['filename']}'. Knowledge base is now empty.",
            "document_removed": doc['filename'],
            "remaining_documents": 0
        }
    
    # Rebuild from remaining documents
    try:
        all_chunks = []
        for remaining in remaining_docs:
            chunks = _reload_document_chunks_from_hash(remaining)
            if chunks:
                all_chunks.extend(chunks)
        
        if all_chunks:
            _global_vectorstore = FAISS.from_documents(all_chunks, get_embeddings())
            save_global_vectorstore()
        
        return {
            "message": f"Deleted '{doc['filename']}'. Knowledge base rebuilt with {len(remaining_docs)} remaining documents.",
            "document_removed": doc['filename'],
            "remaining_documents": len(remaining_docs),
            "total_chunks": _global_vectorstore.index.ntotal if _global_vectorstore else 0,
        }
    except Exception as e:
        print(f"Error rebuilding knowledge base after deletion: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": f"Document record deleted, but could not rebuild index: {str(e)}"}
        )


def _reload_document_chunks_from_hash(doc_info: dict) -> list:
    """Reload a document's chunks from scratch by re-processing the stored file.
    
    Args:
        doc_info: Dict with keys 'filename', 'file_hash', 'file_type'
    
    Returns:
        List of LangChain Document chunks, or empty list if file not found.
    """
    file_hash = doc_info['file_hash']
    filename = doc_info['filename']
    file_ext = doc_info['file_type'].lower()
    
    # Find the permanently stored file
    kb_uploads = get_kb_uploads_path()
    stored_files = [f for f in os.listdir(kb_uploads) if f.startswith(file_hash + '_')]
    
    if not stored_files:
        print(f"Warning: Could not find stored file for {filename} (hash: {file_hash})")
        return []
    
    file_path = os.path.join(kb_uploads, stored_files[0])
    
    try:
        # Load document based on file type
        if file_ext == 'pdf':
            loader = PyPDFLoader(file_path)
            documents = loader.load()
        elif file_ext == 'docx':
            loader = Docx2txtLoader(file_path)
            documents = loader.load()
        elif file_ext == 'txt':
            loader = TextLoader(file_path, encoding='utf-8')
            documents = loader.load()
        elif file_ext == 'epub':
            documents = load_epub(file_path)
            if not documents:
                print(f"Warning: No text extracted from EPUB file {filename}")
                return []
        else:
            print(f"Warning: Unsupported file type {file_ext} for {filename}")
            return []
        
        # Add filename to metadata
        for doc in documents:
            doc.metadata['source_filename'] = filename
        
        # Split into chunks
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        splits = text_splitter.split_documents(documents)
        
        print(f"Re-loaded {filename}: {len(splits)} chunks")
        return splits
        
    except Exception as e:
        print(f"Error reloading {filename}: {e}")
        return []


@app.post("/kb/rebuild")
async def kb_rebuild(_admin: bool = Depends(verify_admin_token)):
    """Rebuild the knowledge base index from all stored documents.
    
    Re-processes all documents stored in the uploads directory.
    """
    global _global_vectorstore
    
    # Get all remaining document records
    documents = get_documents()
    
    if not documents:
        return {
            "message": "No documents to rebuild from.",
            "status": "empty"
        }
    
    try:
        all_chunks = []
        for doc_info in documents:
            chunks = _reload_document_chunks_from_hash(doc_info)
            if chunks:
                all_chunks.extend(chunks)
        
        if all_chunks:
            _global_vectorstore = FAISS.from_documents(all_chunks, get_embeddings())
            save_global_vectorstore()
            
            return {
                "message": f"Knowledge base rebuilt from {len(documents)} documents with {len(all_chunks)} total chunks.",
                "status": "rebuilt",
                "document_count": len(documents),
                "total_chunks": len(all_chunks),
            }
        else:
            return {
                "message": "No chunks could be generated from the stored documents.",
                "status": "no_content"
            }
    except Exception as e:
        print(f"Error rebuilding knowledge base: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": f"Failed to rebuild: {str(e)}"}
        )


# ============================================================
# Legacy Document RAG endpoints (kept for backward compatibility)
# ============================================================

vectorstore_cache = {}
document_hash_map = {}

@app.post("/load_document/")
async def load_document_upload(file: UploadFile = File(...), session_id: str = Form(...)):
    """Upload and process a document file (PDF, DOCX, TXT, EPUB) for RAG. Supports multiple documents by merging.
    
    Also adds the document to the persistent knowledge base so it's available
    for WebSocket chat (not just document mode queries).
    """
    print(f"Received document for processing: {file.filename}")
    os.makedirs(os.path.join(DATA_DIR, "temp_uploads"), exist_ok=True)
    os.makedirs(os.path.join(DATA_DIR, "vectors"), exist_ok=True)

    # Check file type
    file_ext = file.filename.lower().split('.')[-1]
    allowed_extensions = ['pdf', 'docx', 'txt', 'epub']
    
    if file_ext not in allowed_extensions:
        return JSONResponse(
            status_code=400, 
            content={"error": f"Only {', '.join(allowed_extensions).upper()} files are allowed."}
        )

    # Read file content
    file_content = await file.read()
    
    # Calculate file hash to check if we've seen this document before
    file_hash = get_file_hash(file_content)
    
    # Save uploaded file temporarily
    file_location = os.path.join(DATA_DIR, "temp_uploads", file.filename)
    with open(file_location, "wb") as f:
        f.write(file_content)

    # Also save permanently for KB rebuild capability (same as /kb/upload)
    permanent_location = os.path.join(get_kb_uploads_path(), f"{file_hash}_{file.filename}")
    with open(permanent_location, "wb") as f:
        f.write(file_content)

    try:
        # Load document based on file type
        if file_ext == 'pdf':
            loader = PyPDFLoader(file_location)
        elif file_ext == 'docx':
            loader = Docx2txtLoader(file_location)
        elif file_ext == 'txt':
            loader = TextLoader(file_location, encoding='utf-8')
        elif file_ext == 'epub':
            documents = load_epub(file_location)
            if not documents:
                return JSONResponse(
                    status_code=500,
                    content={"error": "Failed to extract text from EPUB file."}
                )
        else:
            return JSONResponse(
                status_code=400,
                content={"error": f"Unsupported file type: {file_ext}"}
            )
        
        if file_ext != 'epub':
            documents = loader.load()
        
        # Add filename to metadata for tracking
        for doc in documents:
            doc.metadata['source_filename'] = file.filename
        
        # Split into text chunks
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        splits = text_splitter.split_documents(documents)
        
        # === PER-SESSION STORE (for Document Mode queries) ===
        if session_id in vectorstore_cache:
            print(f"Merging {file.filename} with existing documents in session {session_id}")
            existing_vectorstore = vectorstore_cache[session_id]
            new_vectorstore = FAISS.from_documents(splits, get_embeddings())
            existing_vectorstore.merge_from(new_vectorstore)
            vectorstore_path = os.path.join(DATA_DIR, "vectors", session_id)
            existing_vectorstore.save_local(vectorstore_path)
            vectorstore_cache[session_id] = existing_vectorstore
        else:
            print(f"Creating new document collection for session {session_id}")
            vectorstore = FAISS.from_documents(splits, get_embeddings())
            vectorstore_path = os.path.join(DATA_DIR, "vectors", session_id)
            os.makedirs(vectorstore_path, exist_ok=True)
            vectorstore.save_local(vectorstore_path)
            vectorstore_cache[session_id] = vectorstore

        # === PERSISTENT KB (for WebSocket chat retrieval) ===
        # Also add to the global persistent knowledge base so normal chat can use it
        merged_global = False
        existing_doc = get_document_by_hash(file_hash)
        if not existing_doc:
            try:
                existing_vs = get_global_vectorstore()
                if existing_vs is not None:
                    print(f"Also adding {file.filename} to persistent knowledge base (merge)")
                    new_vs = FAISS.from_documents(splits, get_embeddings())
                    existing_vs.merge_from(new_vs)
                    save_global_vectorstore()
                    merged_global = True
                else:
                    print(f"Creating persistent knowledge base from {file.filename}")
                    _global_vectorstore = FAISS.from_documents(splits, get_embeddings())
                    save_global_vectorstore()
                    merged_global = True
                
                add_document(file.filename, file_hash, file_ext.upper(), len(splits))
                print(f"Added {file.filename} to persistent KB ({len(splits)} chunks)")
            except Exception as kb_err:
                print(f"Warning: Failed to add {file.filename} to persistent KB: {kb_err}")

        print(f"Successfully processed {file_ext.upper()} for session {session_id}")
        return {
            "message": "Uploaded successfully",
            "filename": file.filename,
            "file_type": file_ext.upper(),
            "merged": False,
            "added_to_kb": merged_global,
        }

    except Exception as e:
        print(f"Error processing document: {str(e)}")
        return JSONResponse(status_code=500, content={"error": str(e)})
    finally:
        # Clean up temp file
        if os.path.exists(file_location):
            os.remove(file_location)


@app.post("/query_document/")
async def query_document(body: dict = Body(...)):
    """Query the uploaded document using RAG."""
    session_id = body.get("session_id")
    prompt = body.get("prompt")
    user_id = body.get("user_id")
    chat_id = body.get("chat_id")
    
    if not session_id or not prompt:
        return JSONResponse(status_code=400, content={"error": "session_id and prompt are required."})
    
    vectorstore_path = os.path.join(DATA_DIR, "vectors", session_id)

    # If vectorstore not cached, attempt to load from disk
    if session_id not in vectorstore_cache:
        if os.path.exists(vectorstore_path):
            try:
                vectorstore = FAISS.load_local(
                    vectorstore_path,
                    get_embeddings(),
                    allow_dangerous_deserialization=True
                )
                vectorstore_cache[session_id] = vectorstore
            except Exception as e:
                return JSONResponse(
                    status_code=500,
                    content={"error": f"Failed to load vectorstore: {str(e)}"}
                )
        else:
            return JSONResponse(
                status_code=400,
                content={"error": "Please load a PDF first for this session."}
            )

    retriever = vectorstore_cache[session_id].as_retriever()

    # Create a prompt to rephrase context-dependent queries
    contextualize_q_prompt = ChatPromptTemplate.from_messages([
        ("system", "Given a chat history and the latest user question which might reference context, formulate a standalone question."),
        MessagesPlaceholder("chat_history"),
        ("human", "{input}"),
    ])
    history_aware_retriever = create_history_aware_retriever(llm, retriever, contextualize_q_prompt)

    # Final answering prompt using context
    qa_prompt = ChatPromptTemplate.from_messages([
        ("system",
         "Use the context below to answer the question **briefly and clearly in short**. Limit your response to key information. If unsure, say you don't know.\n\n{context}"),
        MessagesPlaceholder("chat_history"),
        ("human", "{input}"),
    ])
    document_chain = create_stuff_documents_chain(llm, qa_prompt)
    rag_chain = create_retrieval_chain(history_aware_retriever, document_chain)

    # Combine retrieval with conversation memory
    conversational_rag_chain = RunnableWithMessageHistory(
        rag_chain,
        lambda sid: get_session_history(sid),
        input_messages_key="input",
        history_messages_key="chat_history",
        output_messages_key="answer"
    )

    # Generate response
    try:
        response = conversational_rag_chain.invoke(
            {"input": prompt},
            config={"configurable": {"session_id": session_id}},
        )
        answer = response["answer"]
        
        # Ensure chat exists before saving document-mode messages
        if user_id and chat_id:
            if not chat_exists(chat_id):
                create_chat_with_title(chat_id, user_id, prompt)
            save_message(chat_id, "user", prompt)
            save_message(chat_id, "assistant", answer)
        
        return {"answer": answer}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


app.mount("/static", StaticFiles(directory="static"), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
