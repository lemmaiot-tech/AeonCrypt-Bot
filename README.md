# AeonCrypt's Chatbot - FastAPI + Groq + RAG

A full-featured AI chatbot built with FastAPI, WebSocket streaming, SQLite persistence, and document-based RAG (Retrieval-Augmented Generation).
It supports normal conversation, multi-chat history, and Multi document Q&A over PDF/DOCX/TXT/EPUB files.

## ✨ Features

- Real-time streaming chat responses
- Persistent chat history with multi-chat sidebar
- Upload and query PDF, DOCX, TXT, and EPUB files
- Multi-document merge into one searchable knowledge base
- FAISS-based vector retrieval with context-aware prompting
- Responsive frontend with code block rendering (marked.js + highlight.js)
- Admin-protected Knowledge Base management panel
- CORS-enabled API and Docker/Fly.io deployment ready

## 🧠 How It Works

### 1) Standard Chat Flow
- Browser gets a persistent `user_id` in local storage
- Frontend sends user message to backend through `/ws` (WebSocket)
- Backend creates chat on first message, stores messages in SQLite
- Prompt is built using recent history and sent to Groq model
- Assistant response streams back to UI in real time

### 2) Document (RAG) Flow
- Admin uploads document(s) to `/load_document/` from the Knowledge Base panel
- Backend parses the file (PDF/DOCX/TXT/EPUB), chunks content, creates embeddings using the Hugging Face Inference API model `sentence-transformers/all-MiniLM-L6-v2`
- Embeddings are saved in a single global FAISS index under `vectors/knowledge_base` (per-session vectors are a legacy path)
- User asks questions via WebSocket; the retriever pulls the top-k relevant chunks and the model answers with context
- Q&A is saved to chat history when `user_id` and `chat_id` are provided
- Admin can list/clear the knowledge base via `/admin/knowledge_base` (token-protected)

## 📁 Project Structure

```bash
chatbot-fastapi/
├── app.py
├── database.py
├── requirements.txt
├── chat.db
├── templates/
│   └── index.html
├── static/
│   ├── script.js
│   ├── style.css
│   └── AeonCrypt.png
├── vectors/
├── temp_uploads/
├── Mube-chatbot(workflow).jpeg
└── README.md
```

## ⚙️ Installation

```bash
git clone <repo-url>
cd chatbot-fastapi
python3 -m venv fastapivenv
source fastapivenv/bin/activate
pip install -r requirements.txt
```

Create `.env` in project root:

```env
GROQ_API_KEY=your_groq_api_key_here
HUGGINGFACEHUB_API_TOKEN=your_huggingface_token_here
```

Run the app:

```bash
python app.py
```

Open: `http://localhost:8000`

## 🛠 Tech Stack

- FastAPI
- Groq (`llama-3.1-8b-instant`)
- LangChain
- Embeddings: Hugging Face Inference API (`sentence-transformers/all-MiniLM-L6-v2`)
- FAISS
- SQLite
- Vanilla JavaScript + HTML + CSS

## 🚀 Workflow Diagram

![AeonCrypt Chatbot Workflow](Mube-chatbot(workflow).jpeg)

## ▶️ YouTube Link

- Demo: https://youtu.be/FQVB1vDsxVg
