import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize the Groq AI client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Initialize Google OAuth Client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_dev_key_123';

app.use(cors());
app.use(express.json()); // CRITICAL: This allows us to read JSON data sent to us
app.use(express.static('public')); // This tells Express to show our index.html!


// 1. Connect to MongoDB and Create Schema
mongoose.connect(process.env.MONGODB_URI || '')
  .then(() => console.log('✅ Connected to MongoDB!'))
  .catch(err => console.error('❌ Failed to connect to MongoDB. Did you add MONGODB_URI to .env?', err));

const bookmarkSchema = new mongoose.Schema({
  id: String,
  userId: { type: String, required: true }, // Isolates bookmarks per user!
  url: String,
  title: String,
  category: String,
  summary: String,
});
const Bookmark = mongoose.model('Bookmark', bookmarkSchema);

// User schema — stores each user's custom categories
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  email: String,
  name: String,
  categories: { type: [String], default: [] },
});
const User = mongoose.model('User', userSchema);

// --- AUTHENTICATION ROUTES ---

// 1. Verify Google Login Token & Return our own JWT
app.post('/api/auth/google', async (req: express.Request, res: express.Response): Promise<any> => {
  const { credential } = req.body;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload) return res.status(400).json({ error: "Invalid token" });

    // Create a JWT session token valid for 7 days
    const token = jwt.sign(
      { userId: payload.sub, email: payload.email, name: payload.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user: { email: payload.email, name: payload.name } });
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// Middleware to protect routes
const requireAuth = (req: any, res: express.Response, next: express.NextFunction): any => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// 2. Health check endpoint (you already did this!)
app.get('/api/health', (req: express.Request, res: express.Response) => {
  res.json({ status: 'success', message: 'The Bookmark API is alive!' });
});

// --- CATEGORY ROUTES ---

// Get the logged-in user's categories
app.get('/api/categories', requireAuth, async (req: any, res: express.Response) => {
  const user = await User.findOne({ userId: req.userId });
  res.json({ categories: user?.categories || [] });
});

// Save/update the logged-in user's categories
app.post('/api/categories', requireAuth, async (req: any, res: express.Response) => {
  const { categories } = req.body;
  await User.findOneAndUpdate(
    { userId: req.userId },
    { userId: req.userId, categories },
    { upsert: true, new: true }
  );
  res.json({ message: 'Categories saved!', categories });
});

// --- BOOKMARK ROUTES ---

app.get('/api/bookmarks', requireAuth, async (req: any, res: express.Response) => {
  // Fetch ONLY bookmarks belonging to this user!
  const bookmarks = await Bookmark.find({ userId: req.userId });
  res.json(bookmarks);
});

// ... your existing code ...
// 4. CREATE: Add a new bookmark with Auto-Scraping + AI
app.post('/api/bookmarks', requireAuth, async (req: any, res: express.Response) => {
  const url = req.body.url;

  // Generate a unique ID
  const uniqueId = Date.now().toString();

  // Delete any existing bookmark with the same URL to prevent duplicates (replace with new analysis)
  await Bookmark.deleteMany({ userId: req.userId, url: url });

  let newBookmark: any = {
    id: uniqueId,
    userId: req.userId, // Link bookmark to the logged-in user
    url: url,
    title: "Unknown Title",
    category: "General",
    summary: "No summary available."
  };

  // Step 1: Get the webpage text
  let bodyText = req.body.pageText || ''; // If the Chrome Extension sent the text, use it instantly!

  // Step 1a: For YouTube URLs, grab the title reliably via oEmbed (free, no API key)
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
  if (ytMatch) {
    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json() as any;
        newBookmark.title = oembedData.title || newBookmark.title;
      }
    } catch (e) { /* oEmbed failed, no big deal */ }
  }

  if (!bodyText) {
    // Single fast scrape — no retries, no delays
    try {
      const response = await fetch('https://r.jina.ai/' + url);
      bodyText = await response.text();
      bodyText = bodyText.substring(0, 3000);
    } catch (error) {
      console.log("Could not scrape the website:", url);
    }
  }

  // Step 2: Get the user's custom categories for the AI prompt
  const user = await User.findOne({ userId: req.userId });
  const userCategories = user?.categories?.length ? user.categories : ['General'];

  // Step 3: Ask Groq AI to categorize and summarize
  try {
    // Even if scraping failed, the AI can still guess from the URL!
    const contentForAI = bodyText.length > 50
        ? `URL: ${url}\nWebpage content: ${bodyText}`
        : `URL: ${url} (Note: Could not scrape page content, please analyze based on URL only)`;

    const categoryList = JSON.stringify(userCategories);
    const prompt = `You are a bookmark assistant. Analyze this webpage and return ONLY a valid JSON object (no markdown, no code blocks, no extra text).

The JSON must have exactly three keys:
- "category": one of ${categoryList}
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
app.delete('/api/bookmarks/:id', requireAuth, async (req: any, res: express.Response) => {
  const idToDelete = req.params.id;
  // Ensure we only delete if it belongs to req.userId
  await Bookmark.deleteOne({ id: idToDelete, userId: req.userId });
  res.json({ message: "Bookmark deleted successfully!" });
});

// 6. UPDATE: Edit an existing bookmark's title or category
app.put('/api/bookmarks/:id', requireAuth, async (req: any, res: express.Response): Promise<any> => {
  const idToUpdate = req.params.id;
  const { title, category } = req.body;

  // Find the bookmark in the database belonging to this user
  const bookmark = await Bookmark.findOne({ id: idToUpdate, userId: req.userId });
  
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
