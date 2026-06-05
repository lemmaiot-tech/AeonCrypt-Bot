// ============================================================
// Markdown Rendering Setup (marked + highlight.js)
// ============================================================

const SUPPORTED_LANGS = [
    'javascript','js','python','py','bash','sh','shell','json',
    'sql','xml','html','css','yaml','yml','markdown','md',
    'java','cpp','c','typescript','ts','csharp','c#','go','rust','ruby','php',
    'swift','kotlin','r','matlab','perl','lua','dart','elixir','haskell',
];

if (typeof hljs !== 'undefined') {
    SUPPORTED_LANGS.forEach(lang => {
        try { hljs.registerLanguage(lang, hljs.getLanguage(lang)); } catch (_) {}
    });
}

marked.setOptions({
    gfm: true,
    breaks: true,
    pedantic: false,
    smartypants: false,
});

// Custom renderer for code blocks with copy button + syntax highlighting
const markedRenderer = new marked.Renderer();

markedRenderer.code = function (codeObj) {
    const lang = (codeObj.lang || 'code').trim().toLowerCase();
    const code = codeObj.text !== undefined ? codeObj.text : String(codeObj);
    const escaped = escapeHtml(code);
    const highlightLang = SUPPORTED_LANGS.includes(lang) ? lang : '';
    let highlighted;
    if (highlightLang && typeof hljs !== 'undefined') {
        try { highlighted = hljs.highlight(code, { language: highlightLang }).value; }
        catch (_) { highlighted = escaped; }
    } else {
        highlighted = escaped;
    }
    return `<div class="code-block"><div class="code-block-header"><span class="code-lang">${escapeHtml(lang || 'code')}</span><button type="button" class="copy-code-btn" title="Copy code">📋 Copy</button></div><pre class="hljs"><code>${highlighted}</code></pre></div>`;
};

markedRenderer.codespan = function (codeObj) {
    const text = codeObj.text !== undefined ? codeObj.text : String(codeObj);
    return `<code class="inline-code">${escapeHtml(text)}</code>`;
};

marked.use({ renderer: markedRenderer });

// ============================================================
// User & Connection State
// ============================================================

let userId = localStorage.getItem("user_id");
if (!userId) {
    userId = crypto.randomUUID();
    localStorage.setItem("user_id", userId);
}

let ws = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectDelay = 2000;
const maxReconnectAttempts = 10;

let currentChatId = null;
let documentMode = false;
let documentSessionId = null;
let documentFileNames = [];

// ============================================================
// Admin Auth State
// ============================================================

let adminToken = sessionStorage.getItem("admin_token");

function getAdminHeaders() {
    return adminToken ? { "Authorization": `Bearer ${adminToken}` } : {};
}

function isAdminLoggedIn() {
    return !!adminToken;
}

function clearAdminSession() {
    adminToken = null;
    sessionStorage.removeItem("admin_token");
}

// ============================================================
// DOM References
// ============================================================

const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const charCount = document.getElementById("charCount");
const heroSection = document.getElementById("heroSection");
const newChatBtn = document.getElementById("newChatBtn");
const chatList = document.getElementById("chatList");
const toggleSidebarBtn = document.getElementById("toggleSidebar");
const sidebar = document.getElementById("sidebar");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const mobileBreakpoint = window.matchMedia("(max-width: 768px)");
const attachBtn = document.getElementById("attachBtn");
const fileInput = document.getElementById("fileInput");
const documentModeIndicator = document.getElementById("documentModeIndicator");
const documentFileNameSpan = document.getElementById("documentFileName");
const documentListDiv = document.getElementById("documentList");
const exitDocumentModeBtn = document.getElementById("exitDocumentMode");
const kbAdminBtn = document.getElementById("kbAdminBtn");
const kbAdminPanel = document.getElementById("kbAdminPanel");
const closeKbPanel = document.getElementById("closeKbPanel");
const kbUploadBtn = document.getElementById("kbUploadBtn");
const kbFileInput = document.getElementById("kbFileInput");
const kbUploadArea = document.getElementById("kbUploadArea");
const kbUploadProgress = document.getElementById("kbUploadProgress");
const kbDocList = document.getElementById("kbDocList");
const kbChunkCount = document.getElementById("kbChunkCount");

const isMobileView = () => mobileBreakpoint.matches;

// ============================================================
// Sidebar Management
// ============================================================

const syncSidebarBackdrop = () => {
    if (!sidebarBackdrop) return;
    const showBackdrop = isMobileView() && !sidebar.classList.contains("closed");
    sidebarBackdrop.classList.toggle("visible", showBackdrop);
};

const setSidebarOpen = (isOpen) => {
    sidebar.classList.toggle("closed", !isOpen);
    toggleSidebarBtn.setAttribute("aria-expanded", String(isOpen));
    syncSidebarBackdrop();
};

let previousIsMobile = isMobileView();

const syncSidebarForViewport = () => {
    const nowMobile = isMobileView();
    if (nowMobile !== previousIsMobile) {
        setSidebarOpen(!nowMobile);
        previousIsMobile = nowMobile;
    } else {
        syncSidebarBackdrop();
    }
};

// ============================================================
// Scroll Helpers
// ============================================================

const scrollToLatest = () => {
    requestAnimationFrame(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
};

// ============================================================
// Mode Transitions
// ============================================================

const enterChatMode = () => {
    if (document.body.classList.contains("chat-mode")) return;
    document.body.classList.remove("initial-mode");
    document.body.classList.add("chat-mode");
    heroSection.setAttribute("aria-hidden", "true");
    chatMessages.classList.remove("d-none");
};

// ============================================================
// Text Helpers
// ============================================================

const escapeHtml = (text) =>
    text
        .replace(/&/g, "\u0026amp;")
        .replace(/</g, "\u0026lt;")
        .replace(/>/g, "\u0026gt;")
        .replace(/"/g, "\u0026quot;")
        .replace(/'/g, "\u0026#039;");

/**
 * Render markdown content for user-visible plain text with basic formatting.
 */
const formatText = (text) =>
    escapeHtml(text)
        .replace(/\n/g, "<br>");

// ============================================================
// Assistant Markdown Rendering (via marked)
// ============================================================

const renderAssistantContent = (node, raw) => {
    if (!raw || !raw.trim()) {
        node.innerHTML = "&nbsp;";
        return;
    }

    // Split out fenced code blocks so streaming doesn't break mid-render.
    // We render everything through marked, which handles incomplete fences gracefully.
    let html;
    try {
        html = marked.parse(raw);
    } catch (e) {
        html = `<p>${escapeHtml(raw)}</p>`;
    }

    node.innerHTML = html || "&nbsp;";

    // Highlight any <code> blocks not caught by the renderer (fallback)
    node.querySelectorAll('pre code').forEach(block => {
        if (typeof hljs !== 'undefined') {
            hljs.highlightElement(block);
        }
    });
};

// ============================================================
// Message Construction
// ============================================================

const addMessage = (role, content = "") => {
    enterChatMode();

    const row = document.createElement("div");
    row.className = `message-group d-flex ${role === "user" ? "justify-content-end" : "justify-content-start"} ${role}`;

    const bubble = document.createElement("div");
    bubble.className = role === "user" ? "user-msg" : "bot-msg";

    if (role === "user") {
        bubble.textContent = content;
    } else {
        // Store raw content for copy/share/feedback
        bubble.dataset.rawContent = content;
        renderAssistantContent(bubble, content);

        // Add toolbar for bot messages
        const toolbar = createMessageToolbar(bubble);
        bubble.appendChild(toolbar);
    }

    row.appendChild(bubble);
    chatMessages.appendChild(row);
    scrollToLatest();
    return bubble;
};

// ============================================================
// Message Toolbar (Copy / Share / Feedback)
// ============================================================

function createMessageToolbar(bubble) {
    const toolbar = document.createElement("div");
    toolbar.className = "msg-toolbar";

    // Copy button
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "msg-toolbar-btn copy-response-btn";
    copyBtn.title = "Copy response";
    copyBtn.innerHTML = "📋";
    copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const raw = bubble.dataset.rawContent || "";
        navigator.clipboard.writeText(raw).then(() => {
            copyBtn.innerHTML = "✅";
            copyBtn.title = "Copied!";
            setTimeout(() => { copyBtn.innerHTML = "📋"; copyBtn.title = "Copy response"; }, 1500);
        }).catch(() => {
            // Fallback: textarea select
            const ta = document.createElement("textarea");
            ta.value = raw;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand("copy"); copyBtn.innerHTML = "✅"; setTimeout(() => { copyBtn.innerHTML = "📋"; }, 1500); } catch (_) {}
            document.body.removeChild(ta);
        });
    });

    // Share button
    const shareBtn = document.createElement("button");
    shareBtn.type = "button";
    shareBtn.className = "msg-toolbar-btn share-response-btn";
    shareBtn.title = "Share response";
    shareBtn.innerHTML = "🔗";
    shareBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const raw = bubble.dataset.rawContent || "";
        const shareText = `From AeonCrypt Chatbot:\n\n${raw}`;

        if (navigator.share) {
            try {
                await navigator.share({ title: "AeonCrypt Chatbot Response", text: shareText });
                shareBtn.innerHTML = "✅";
                setTimeout(() => { shareBtn.innerHTML = "🔗"; }, 1500);
            } catch (err) {
                if (err.name !== "AbortError") fallbackCopy(shareBtn, shareText);
            }
        } else {
            fallbackCopy(shareBtn, shareText);
        }
    });

    // Feedback buttons (thumbs up / thumbs down)
    const thumbUp = document.createElement("button");
    thumbUp.type = "button";
    thumbUp.className = "msg-toolbar-btn feedback-btn feedback-up";
    thumbUp.title = "Good response";
    thumbUp.innerHTML = "👍";

    const thumbDown = document.createElement("button");
    thumbDown.type = "button";
    thumbDown.className = "msg-toolbar-btn feedback-btn feedback-down";
    thumbDown.title = "Bad response";
    thumbDown.innerHTML = "👎";

    let feedbackValue = null;

    const sendFeedback = async (value) => {
        if (feedbackValue === value) {
            // Toggle off
            feedbackValue = null;
            thumbUp.classList.remove("active");
            thumbDown.classList.remove("active");
            return;
        }
        feedbackValue = value;
        thumbUp.classList.toggle("active", value === "positive");
        thumbDown.classList.toggle("active", value === "negative");

        try {
            const responseIndex = getBotMessageIndex(bubble);
            await fetch("/feedback", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    user_id: userId,
                    chat_id: currentChatId,
                    message_index: responseIndex,
                    feedback: value,
                }),
            });
        } catch (err) {
            console.error("Feedback send failed:", err);
        }
    };

    thumbUp.addEventListener("click", (e) => { e.stopPropagation(); sendFeedback("positive"); });
    thumbDown.addEventListener("click", (e) => { e.stopPropagation(); sendFeedback("negative"); });

    toolbar.appendChild(copyBtn);
    toolbar.appendChild(shareBtn);
    toolbar.appendChild(thumbUp);
    toolbar.appendChild(thumbDown);

    return toolbar;
}

function getBotMessageIndex(bubble) {
    const botMessages = document.querySelectorAll(".message-group.bot .bot-msg");
    for (let i = 0; i < botMessages.length; i++) {
        if (botMessages[i] === bubble) return i;
    }
    return -1;
}

function fallbackCopy(btn, text) {
    navigator.clipboard.writeText(text).then(() => {
        btn.innerHTML = "✅";
        btn.title = "Copied!";
        setTimeout(() => { btn.innerHTML = "🔗"; btn.title = "Share response"; }, 1500);
    }).catch(() => {
        // Last resort
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); btn.innerHTML = "✅"; setTimeout(() => { btn.innerHTML = "🔗"; }, 1500); } catch (_) {}
        document.body.removeChild(ta);
    });
}

// ============================================================
// Streaming & Message Display
// ============================================================

const appendStream = (chunk) => {
    const botMessages = document.querySelectorAll(".message-group.bot .bot-msg");
    if (!botMessages.length) return;
    const last = botMessages[botMessages.length - 1];
    const nextRaw = (last.dataset.rawContent || "") + chunk;
    last.dataset.rawContent = nextRaw;

    // Save toolbar reference before renderAssistantContent destroys innerHTML
    let toolbar = last.querySelector(".msg-toolbar");

    renderAssistantContent(last, nextRaw);

    // Re-append the preserved toolbar (DOM node survives detach)
    if (!toolbar) {
        toolbar = createMessageToolbar(last);
    }
    last.appendChild(toolbar);

    scrollToLatest();
};

const clearChat = () => {
    chatMessages.innerHTML = "";
    document.body.classList.remove("chat-mode");
    document.body.classList.add("initial-mode");
    heroSection.removeAttribute("aria-hidden");
};

const setInputState = (disabled) => {
    sendBtn.disabled = disabled;
    messageInput.disabled = disabled;
};

// ============================================================
// WebSocket Reconnection
// ============================================================

const attemptReconnect = () => {
    if (reconnectAttempts >= maxReconnectAttempts) {
        addMessage("bot", "❌ Unable to connect. Please refresh the page.");
        return;
    }
    reconnectAttempts += 1;
    setTimeout(connectWebSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
};

const connectWebSocket = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    try {
        ws = new WebSocket(wsUrl);
    } catch (error) {
        console.error("Failed to create WebSocket:", error);
        attemptReconnect();
        return;
    }

    ws.onopen = () => {
        isConnected = true;
        reconnectAttempts = 0;
        reconnectDelay = 2000;
        setInputState(false);
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === "stream") {
                appendStream(data.content);
            } else if (data.type === "complete") {
                setInputState(false);
                scrollToLatest();
            } else if (data.type === "error") {
                addMessage("bot", `❌ Error: ${data.content}`);
                setInputState(false);
                scrollToLatest();
            }
        } catch (error) {
            console.error("Error parsing message:", error);
        }
    };

    ws.onerror = () => { isConnected = false; };
    ws.onclose = () => { isConnected = false; attemptReconnect(); };
};

// ============================================================
// Send Message
// ============================================================

const sendMessage = async () => {
    const text = messageInput.value.trim();
    if (!text) return;

    // Document Mode
    if (documentMode && documentSessionId) {
        addMessage("user", text);
        const botBubble = addMessage("bot", "");
        messageInput.value = "";
        messageInput.style.height = "auto";
        charCount.textContent = "0";
        setInputState(true);

        try {
            if (!currentChatId) {
                const res = await fetch("/new_chat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ user_id: userId })
                });
                const data = await res.json();
                currentChatId = data.chat_id;
                await loadChatList();
            }

            const response = await fetch("/query_document/", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    session_id: documentSessionId,
                    prompt: text,
                    user_id: userId,
                    chat_id: currentChatId
                })
            });
            const data = await response.json();

            if (response.ok) {
                botBubble.dataset.rawContent = data.answer;
                renderAssistantContent(botBubble, data.answer);
                // Re-attach toolbar
                let toolbar = botBubble.querySelector(".msg-toolbar");
                if (!toolbar) toolbar = createMessageToolbar(botBubble);
                botBubble.appendChild(toolbar);
            } else {
                botBubble.textContent = `❌ Error: ${data.error || "Failed to query document"}`;
            }
        } catch (error) {
            botBubble.textContent = `❌ Error: ${error.message}`;
        } finally {
            setInputState(false);
            scrollToLatest();
        }
        return;
    }

    // Normal Chat Mode
    if (!isConnected) {
        alert("Not connected to server. Trying to reconnect...");
        return;
    }

    if (!currentChatId) {
        try {
            const res = await fetch("/new_chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user_id: userId })
            });
            const data = await res.json();
            currentChatId = data.chat_id;
            await loadChatList();
        } catch (error) {
            console.error("Failed to create chat:", error);
            alert("Failed to create chat. Please try again.");
            return;
        }
    }

    enterChatMode();
    addMessage("user", text);
    addMessage("bot", "");
    messageInput.value = "";
    messageInput.style.height = "auto";
    charCount.textContent = "0";
    setInputState(true);

    ws.send(JSON.stringify({
        user_id: userId,
        chat_id: currentChatId,
        content: text
    }));
};

// ============================================================
// Chat Management
// ============================================================

const createNewChat = async () => {
    try {
        const response = await fetch("/new_chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: userId })
        });
        const data = await response.json();
        currentChatId = data.chat_id;
        clearChat();

        documentMode = false;
        documentSessionId = null;
        documentFileNames = [];
        documentModeIndicator.style.display = "none";
        documentListDiv.style.display = "none";
        messageInput.placeholder = "Message AeonCrypt...";

        await loadChatList();
        if (isMobileView()) setSidebarOpen(false);
        setInputState(false);
    } catch (error) {
        console.error("Failed to create new chat:", error);
        alert("Failed to create new chat");
    }
};

const loadChatList = async () => {
    try {
        const response = await fetch(`/chats/${userId}`);
        const chats = await response.json();
        chatList.innerHTML = "";

        if (chats.length === 0) {
            chatList.innerHTML = '<div class="text-secondary p-3 text-center small">No chats yet</div>';
            return;
        }

        chats.forEach(chat => {
            const chatItem = document.createElement("div");
            chatItem.className = "chat-item";
            chatItem.dataset.id = chat.chat_id;
            chatItem.dataset.chatId = chat.chat_id;

            const titleSpan = document.createElement("span");
            titleSpan.className = "chat-title";
            titleSpan.textContent = chat.title;
            titleSpan.title = chat.title;

            const menuBtn = document.createElement("button");
            menuBtn.className = "chat-menu-btn";
            menuBtn.type = "button";
            menuBtn.textContent = "⋯";

            const menu = document.createElement("div");
            menu.className = "chat-menu";

            const renameBtn = document.createElement("button");
            renameBtn.className = "rename-chat";
            renameBtn.type = "button";
            renameBtn.textContent = "Rename";

            const deleteBtn = document.createElement("button");
            deleteBtn.className = "delete-chat";
            deleteBtn.type = "button";
            deleteBtn.textContent = "Delete";

            menu.appendChild(renameBtn);
            menu.appendChild(deleteBtn);

            chatItem.appendChild(titleSpan);
            chatItem.appendChild(menuBtn);
            chatItem.appendChild(menu);

            if (chat.chat_id === currentChatId) chatItem.classList.add("active");

            titleSpan.addEventListener("click", () => loadChatMessages(chat.chat_id));
            chatList.appendChild(chatItem);
        });
    } catch (error) {
        console.error("Failed to load chats:", error);
    }
};

const loadChatMessages = async (chatId) => {
    try {
        const response = await fetch(`/chat/${chatId}`);
        if (!response.ok) { alert("Failed to load chat"); return; }

        const messages = await response.json();
        clearChat();
        currentChatId = chatId;

        documentMode = false;
        documentSessionId = null;
        documentFileNames = [];
        documentModeIndicator.style.display = "none";
        documentListDiv.style.display = "none";
        messageInput.placeholder = "Message AeonCrypt...";

        document.querySelectorAll(".chat-item").forEach(item => {
            item.classList.remove("active");
            if (item.dataset.chatId === chatId) item.classList.add("active");
        });

        if (messages.length > 0) {
            enterChatMode();
            messages.forEach(msg => addMessage(msg.role, msg.content));
        }

        if (isMobileView()) setSidebarOpen(false);
        setInputState(false);
    } catch (error) {
        console.error("Failed to load chat messages:", error);
        alert("Failed to load chat");
    }
};

// ============================================================
// Event Listeners
// ============================================================

messageInput.addEventListener("input", () => {
    messageInput.style.height = "auto";
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`;
    charCount.textContent = messageInput.value.length;
});

chatForm.addEventListener("submit", (event) => { event.preventDefault(); sendMessage(); });
sendBtn.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); }
});

// Delegated click handler for code block copy buttons
chatMessages.addEventListener("click", async (event) => {
    const button = event.target.closest(".copy-code-btn");
    if (!button) return;

    const code = button.closest(".code-block")?.querySelector("code")?.textContent || "";
    if (!code) return;

    try {
        await navigator.clipboard.writeText(code);
        button.textContent = "✅ Copied!";
        setTimeout(() => { button.textContent = "📋 Copy"; }, 1200);
    } catch (error) {
        console.error("Copy failed:", error);
    }
});

newChatBtn.addEventListener("click", createNewChat);

toggleSidebarBtn.addEventListener("click", () => {
    const shouldOpen = sidebar.classList.contains("closed");
    setSidebarOpen(shouldOpen);
});

sidebarBackdrop?.addEventListener("click", () => { setSidebarOpen(false); });
window.addEventListener("resize", syncSidebarForViewport);

// Menu toggle
document.addEventListener("click", (e) => {
    if (e.target.classList.contains("chat-menu-btn")) {
        const menu = e.target.nextElementSibling;
        const isVisible = menu.style.display === "flex";
        document.querySelectorAll(".chat-menu").forEach(m => { m.style.display = "none"; });
        menu.style.display = isVisible ? "none" : "flex";
        e.stopPropagation();
    } else if (!e.target.closest(".chat-menu")) {
        document.querySelectorAll(".chat-menu").forEach(m => { m.style.display = "none"; });
    }
});

// Rename chat
document.addEventListener("click", (e) => {
    if (e.target.classList.contains("rename-chat")) {
        const chatId = e.target.closest(".chat-item").dataset.id;
        const newName = prompt("Rename chat to:");
        if (!newName) return;
        fetch(`/chat/${chatId}/rename`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: newName }),
        }).then(() => loadChatList());
    }
});

// Delete chat
document.addEventListener("click", (e) => {
    if (e.target.classList.contains("delete-chat")) {
        const chatId = e.target.closest(".chat-item").dataset.id;
        if (!confirm("Delete this chat?")) return;
        fetch(`/chat/${chatId}`, { method: "DELETE" }).then(() => {
            if (currentChatId === chatId) { currentChatId = null; clearChat(); }
            loadChatList();
        });
    }
});

// ============================================================
// Init
// ============================================================

window.addEventListener("load", async () => {
    setSidebarOpen(!isMobileView());
    connectWebSocket();
    await loadChatList();
    setTimeout(async () => {
        const response = await fetch(`/chats/${userId}`);
        const chats = await response.json();
        if (chats.length === 0) await createNewChat();
    }, 500);
});

// ============================================================
// File Attachment
// ============================================================

attachBtn?.addEventListener("click", () => { fileInput.click(); });

fileInput?.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
        for (const file of files) { await uploadDocument(file); }
    }
});

exitDocumentModeBtn?.addEventListener("click", () => {
    documentMode = false;
    documentSessionId = null;
    documentFileNames = [];
    documentModeIndicator.style.display = "none";
    messageInput.placeholder = "Message AeonCrypt...";
});

async function uploadDocument(file) {
    const fileExt = file.name.split('.').pop().toLowerCase();
    const allowedTypes = ['pdf', 'docx', 'txt', 'epub'];
    if (!allowedTypes.includes(fileExt)) {
        alert(`Please upload a PDF, EPUB, DOCX, or TXT file. You selected: ${fileExt.toUpperCase()}`);
        fileInput.value = "";
        return;
    }

    const formData = new FormData();
    const sessionId = documentSessionId || crypto.randomUUID();
    formData.append("file", file);
    formData.append("session_id", sessionId);

    const uploadMsg = addMessage("bot", `📤 Uploading ${file.name}...`);
    setInputState(true);

    try {
        const response = await fetch("/load_document/", { method: "POST", body: formData });
        const data = await response.json();

        if (response.ok) {
            const isMerged = data.merged || false;
            const addedToKb = data.added_to_kb || false;
            if (isMerged) {
                uploadMsg.textContent = `✅ ${data.filename} added to existing documents! Ask questions across all uploaded files.${addedToKb ? ' (Also added to knowledge base for future chats)' : ''}`;
            } else {
                uploadMsg.textContent = `✅ ${data.filename} uploaded successfully! You can now ask questions about it.${addedToKb ? ' (Also added to knowledge base for future chats)' : ''}`;
            }
            documentMode = true;
            documentSessionId = sessionId;
            if (!documentFileNames.includes(file.name)) documentFileNames.push(file.name);
            updateDocumentIndicator();
            fileInput.value = "";
            setInputState(false);
        } else {
            uploadMsg.textContent = `❌ Error: ${data.error || "Failed to upload document"}`;
            setInputState(false);
        }
    } catch (error) {
        uploadMsg.textContent = `❌ Error: ${error.message}`;
        setInputState(false);
    }
    scrollToLatest();
}

function updateDocumentIndicator() {
    if (documentFileNames.length === 0) {
        documentModeIndicator.style.display = "none";
        documentListDiv.style.display = "none";
        messageInput.placeholder = "Message AeonCrypt...";
        return;
    }
    if (documentFileNames.length === 1) {
        documentFileNameSpan.textContent = `📄 ${documentFileNames[0]}`;
        documentListDiv.style.display = "none";
        messageInput.placeholder = `Ask questions about ${documentFileNames[0]}...`;
    } else {
        documentFileNameSpan.textContent = `📄 ${documentFileNames.length} documents loaded (click to view)`;
        documentFileNameSpan.style.cursor = "pointer";
        messageInput.placeholder = `Ask questions about your ${documentFileNames.length} documents...`;
        documentListDiv.innerHTML = documentFileNames.map((name, idx) =>
            `<div class="doc-item">${idx + 1}. ${name}</div>`
        ).join('');
    }
    documentModeIndicator.style.display = "flex";
}

documentFileNameSpan?.addEventListener("click", () => {
    if (documentFileNames.length > 1) {
        const isVisible = documentListDiv.style.display === "block";
        documentListDiv.style.display = isVisible ? "none" : "block";
    }
});

// ============================================================
// Knowledge Base Admin Panel (Auth-gated)
// ============================================================

// DOM refs for admin login modal
const adminLoginModal = document.getElementById("adminLoginModal");
const adminLoginForm = document.getElementById("adminLoginForm");
const adminPasswordInput = document.getElementById("adminPasswordInput");
const adminLoginBtn = document.getElementById("adminLoginBtn");
const adminLoginError = document.getElementById("adminLoginError");
const closeAdminModal = document.getElementById("closeAdminModal");

function openKbAdminPanel() {
    kbAdminPanel.style.display = "flex";
    chatMessages.style.display = "none";
    heroSection.style.display = "none";
    loadKbDocuments();
}

function closeKbAdminPanel() {
    kbAdminPanel.style.display = "none";
    chatMessages.style.display = "";
    heroSection.style.display = "";
}

function showAdminLoginModal() {
    adminLoginModal.style.display = "flex";
    adminPasswordInput.value = "";
    adminLoginError.style.display = "none";
    adminPasswordInput.focus();
}

function hideAdminLoginModal() {
    adminLoginModal.style.display = "none";
}

kbAdminBtn?.addEventListener("click", () => {
    const isVisible = kbAdminPanel.style.display !== "none";
    if (isVisible) {
        closeKbAdminPanel();
        return;
    }
    // If already logged in, open panel directly
    if (isAdminLoggedIn()) {
        openKbAdminPanel();
    } else {
        showAdminLoginModal();
    }
});

closeKbPanel?.addEventListener("click", closeKbAdminPanel);
closeAdminModal?.addEventListener("click", hideAdminLoginModal);

// Handle admin login form submission
adminLoginForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = adminPasswordInput.value.trim();
    if (!password) return;

    adminLoginBtn.disabled = true;
    adminLoginBtn.textContent = "Logging in...";
    adminLoginError.style.display = "none";

    try {
        const response = await fetch("/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
        });
        const data = await response.json();

        if (response.ok && data.token) {
            adminToken = data.token;
            sessionStorage.setItem("admin_token", adminToken);
            hideAdminLoginModal();
            openKbAdminPanel();
        } else {
            adminLoginError.textContent = data.error || "Invalid password";
            adminLoginError.style.display = "block";
        }
    } catch (error) {
        adminLoginError.textContent = "Login failed. Please try again.";
        adminLoginError.style.display = "block";
    } finally {
        adminLoginBtn.disabled = false;
        adminLoginBtn.textContent = "Login";
    }
});

// Allow closing modal on backdrop click
adminLoginModal?.addEventListener("click", (e) => {
    if (e.target === adminLoginModal) hideAdminLoginModal();
});

kbUploadBtn?.addEventListener("click", () => { kbFileInput.click(); });

kbFileInput?.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
        for (const file of files) { await uploadToKnowledgeBase(file); }
    }
    kbFileInput.value = "";
});

kbUploadArea?.addEventListener("dragover", (e) => {
    e.preventDefault();
    kbUploadArea.classList.add("kb-dragover");
});

kbUploadArea?.addEventListener("dragleave", () => { kbUploadArea.classList.remove("kb-dragover"); });

kbUploadArea?.addEventListener("drop", async (e) => {
    e.preventDefault();
    kbUploadArea.classList.remove("kb-dragover");
    const files = Array.from(e.dataTransfer.files);
    const allowedTypes = ['.pdf', '.epub', '.docx', '.txt'];
    for (const file of files) {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        if (allowedTypes.includes(ext)) {
            await uploadToKnowledgeBase(file);
        } else {
            showKbUploadMessage(`❌ ${file.name}: Unsupported file type. Allowed: PDF, EPUB, DOCX, TXT`, "error");
        }
    }
});

async function uploadToKnowledgeBase(file) {
    const formData = new FormData();
    formData.append("file", file);
    showKbUploadMessage(`📤 Uploading ${file.name}...`, "info");

    try {
        const response = await fetch("/kb/upload", {
            method: "POST",
            headers: getAdminHeaders(),
            body: formData,
        });
        const data = await response.json();
        if (response.ok) {
            showKbUploadMessage(`✅ ${file.name} added to knowledge base!`, "success");
        } else if (response.status === 401) {
            showKbUploadMessage(`❌ Session expired. Please login again.`, "error");
            clearAdminSession();
            closeKbAdminPanel();
            showAdminLoginModal();
            return;
        } else if (response.status === 409) {
            showKbUploadMessage(`⚠️ ${file.name}: Already uploaded.`, "warning");
        } else {
            showKbUploadMessage(`❌ ${file.name}: ${data.error || "Upload failed"}`, "error");
        }
    } catch (error) {
        showKbUploadMessage(`❌ ${file.name}: ${error.message}`, "error");
    }
    await loadKbDocuments();
}

function showKbUploadMessage(message, type) {
    const msgEl = document.createElement("div");
    msgEl.className = `kb-upload-msg kb-msg-${type}`;
    msgEl.textContent = message;
    kbUploadProgress.appendChild(msgEl);
    kbUploadProgress.style.display = "block";
    setTimeout(() => {
        msgEl.remove();
        if (kbUploadProgress.children.length === 0) kbUploadProgress.style.display = "none";
    }, 5000);
}

async function loadKbDocuments() {
    kbDocList.innerHTML = '<div class="kb-loading">Loading documents...</div>';
    try {
        const response = await fetch("/kb/status");
        const data = await response.json();
        if (data.documents.length === 0) {
            kbDocList.innerHTML = '<div class="kb-empty">No documents uploaded yet. Upload PDF, EPUB, DOCX, or TXT files above.</div>';
        } else {
            kbDocList.innerHTML = data.documents.map(doc => `
                <div class="kb-doc-item" data-id="${doc.id}">
                    <div class="kb-doc-info">
                        <span class="kb-doc-icon">${getFileIcon(doc.file_type)}</span>
                        <div class="kb-doc-details">
                            <span class="kb-doc-name">${escapeHtml(doc.filename)}</span>
                            <span class="kb-doc-meta">${doc.file_type} • ${doc.chunk_count} chunks • ${formatDate(doc.uploaded_at)}</span>
                        </div>
                    </div>
                    <button type="button" class="kb-doc-delete" title="Remove from knowledge base" data-id="${doc.id}">🗑️</button>
                </div>
            `).join('');

            document.querySelectorAll(".kb-doc-delete").forEach(btn => {
                btn.addEventListener("click", async () => {
                    const docId = btn.dataset.id;
                    if (confirm("Remove this document from the knowledge base?")) {
                        await deleteKbDocument(docId);
                    }
                });
            });
        }
        kbChunkCount.textContent = data.chunk_count || 0;
    } catch (error) {
        kbDocList.innerHTML = `<div class="kb-error">❌ Failed to load documents: ${error.message}</div>`;
    }
}

async function deleteKbDocument(docId) {
    try {
        const response = await fetch(`/kb/document/${docId}`, {
            method: "DELETE",
            headers: getAdminHeaders(),
        });
        const data = await response.json();
        if (response.ok) {
            await loadKbDocuments();
        } else if (response.status === 401) {
            alert("Session expired. Please login again.");
            clearAdminSession();
            closeKbAdminPanel();
            showAdminLoginModal();
        } else {
            alert(`Failed to delete: ${data.error}`);
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

function getFileIcon(fileType) {
    const icons = { 'PDF': '📕', 'EPUB': '📖', 'DOCX': '📘', 'TXT': '📄' };
    return icons[fileType] || '📄';
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr + 'Z');
    return date.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}