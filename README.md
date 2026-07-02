# 🧠 AI-Powered Smart Bookmark Manager


A blazing-fast, visually stunning, and highly secure bookmark manager that uses **Google Gemini AI** to automatically summarize and categorize your saved links. Stop losing your bookmarks in endless folders, and let AI do the organizing for you!

## ✨ Features

- 🤖 **AI Auto-Categorization & Summarization** — Paste a URL, and Gemini AI will instantly read the page, write a short summary, and assign it to the correct category (e.g., AI/ML, Web Dev, Gaming, Fitness).
- 🎨 **Beautiful Custom SVG Animations** — Enjoy a premium dark-mode UI with smooth glowing gradients and custom hand-drawn, fully animated SVG illustrations for each category.
- 🔒 **End-to-End Encryption (E2E)** — Total privacy. Enable E2E in Settings and lock your bookmarks with a Privacy PIN. Your data is encrypted locally before it ever reaches the database.
- 🔄 **Chrome Bookmark Sync** — Easily bulk-import your existing Chrome bookmarks (`.html`). The AI will process them in the background and neatly organize years of saved links.
- 🔍 **Intelligent Search** — Instantly search through your bookmarks by title, URL, or even the AI-generated summaries.
- ⚙️ **Customizable Interests** — Tell the AI what topics you care about during onboarding or in the Settings tab, ensuring highly personalized categorization.

## 🛠️ Tech Stack

- **Frontend**: Vanilla HTML / CSS / TypeScript
- **Backend/API**: Node.js, Express
- **AI Integration**: Google Gemini API (`@google/genai`)
- **Database**: PostgreSQL (via Supabase)
- **Security**: AES-GCM (Web Crypto API) for client-side E2E encryption

## 🚀 Getting Started

### Prerequisites
- Node.js (v16+)
- A [Google Gemini API Key](https://aistudio.google.com/)
- A [Supabase](https://supabase.com/) project (PostgreSQL)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/AI-Powered_Smart_Bookmark_Manager.git
   cd AI-Powered_Smart_Bookmark_Manager
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up Environment Variables:**
   Create a `.env` file in the root directory and add your keys:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   SUPABASE_URL=your_supabase_project_url
   SUPABASE_SERVICE_KEY=your_supabase_service_role_key
   PORT=3000
   ```

4. **Start the Development Server:**
   ```bash
   npm run dev
   ```
   The application will be available at `http://localhost:3000`.

## 🖼️ Screenshots

> **Note to Developer:** Add more screenshots of the animated UI, E2E unlock screen, and Chrome Sync here by dragging and dropping them into GitHub!

<div align="center">
  <!-- Paste your new image links here! -->
</div>

## 🛡️ Security & Privacy
If you enable **End-to-End Encryption**, your titles, URLs, and summaries are encrypted using AES-GCM directly in your browser. The server and database only ever receive encrypted ciphertext. **Do not lose your PIN**, as it is impossible to decrypt your bookmarks without it.

---

