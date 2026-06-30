import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize the Groq AI client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(cors());
app.use(express.json()); // CRITICAL: This allows us to read JSON data sent to us
app.use(express.static('public')); // This tells Express to show our index.html!


// 1. Connect to MongoDB and Create Schema
mongoose.connect(process.env.MONGODB_URI || '')
  .then(() => console.log('✅ Connected to MongoDB!'))
  .catch(err => console.error('❌ Failed to connect to MongoDB. Did you add MONGODB_URI to .env?', err));

const bookmarkSchema = new mongoose.Schema({
  id: String,
  url: String,
  title: String,
  category: String,
  summary: String,
});
const Bookmark = mongoose.model('Bookmark', bookmarkSchema);

// 2. Health check endpoint (you already did this!)
app.get('/api/health', (req: express.Request, res: express.Response) => {
  res.json({ status: 'success', message: 'The Bookmark API is alive!' });
});

app.get('/api/bookmarks', async (req: express.Request, res: express.Response) => {
  // Fetch all bookmarks from the database!
  const bookmarks = await Bookmark.find();
  res.json(bookmarks);
});

// ... your existing code ...
// 4. CREATE: Add a new bookmark with Auto-Scraping + AI
app.post('/api/bookmarks', async (req: express.Request, res: express.Response) => {
  const url = req.body.url;

  // Generate a unique ID
  const uniqueId = Date.now().toString();

  let newBookmark: any = {
    id: uniqueId,
    url: url,
    title: "Unknown Title",
    category: "General",
    summary: "No summary available."
  };

  // Step 1: Get the webpage text
  let bodyText = req.body.pageText || ''; // If the Chrome Extension sent the text, use it instantly!

  if (!bodyText) {
    // If it came from the web UI (no pageText provided), use a lightweight API to scrape it
    try {
      const response = await fetch('https://r.jina.ai/' + url);
      bodyText = await response.text();
      bodyText = bodyText.substring(0, 3000); // Keep it short for the AI
    } catch (error) {
      console.log("Could not scrape the website:", url);
    }
  }

  // Step 2: Ask Groq AI to categorize and summarize
  try {
    // Even if scraping failed, the AI can still guess from the URL!
    const contentForAI = bodyText.length > 50
        ? `URL: ${url}\nWebpage content: ${bodyText}`
        : `URL: ${url} (Note: Could not scrape page content, please analyze based on URL only)`;

    const prompt = `You are a bookmark assistant. Analyze this webpage and return ONLY a valid JSON object (no markdown, no code blocks, no extra text).

The JSON must have exactly three keys:
- "category": one of ["DSA", "Jobs", "Reading", "General"]
- "summary": a single sentence (max 20 words) summarizing the page
- "title": a clean, short title for this page (max 8 words)

${contentForAI}`;

    const completion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
    });
    
    const aiText = completion.choices[0]?.message?.content?.trim() || "{}";

    // Parse the AI's JSON response
    const parsed = JSON.parse(aiText);
    if (parsed.category) newBookmark.category = parsed.category;
    if (parsed.summary) newBookmark.summary = parsed.summary;
    // Only use AI title if scraping didn't get a good one
    if (newBookmark.title === "Unknown Title" && parsed.title) {
      newBookmark.title = parsed.title;
    }
  } catch (error) {
    console.log("AI analysis failed:", error);
  }

  // Save the new bookmark to MongoDB!
  const dbBookmark = new Bookmark(newBookmark);
  await dbBookmark.save();

  res.json({ message: "Bookmark saved!", bookmark: dbBookmark });
});

// 5. DELETE: Remove a bookmark
app.delete('/api/bookmarks/:id', async (req: express.Request, res: express.Response) => {
  const idToDelete = req.params.id;
  await Bookmark.deleteOne({ id: idToDelete });
  res.json({ message: "Bookmark deleted successfully!" });
});

// 6. UPDATE: Edit an existing bookmark's title or category
app.put('/api/bookmarks/:id', async (req: express.Request, res: express.Response) => {
  const idToUpdate = req.params.id;
  const { title, category } = req.body;

  // Find the bookmark in the database
  const bookmark = await Bookmark.findOne({ id: idToUpdate });
  
  if (!bookmark) {
    return res.status(404).json({ error: "Bookmark not found" });
  }

  // Update properties if provided in the request body
  if (title) bookmark.title = title;
  if (category) bookmark.category = category;

  await bookmark.save();
  res.json({ message: "Bookmark updated successfully!", bookmark });
});


app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
