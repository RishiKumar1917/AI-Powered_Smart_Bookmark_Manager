import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize the Groq AI client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Initialize Google OAuth Client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_dev_key_123';

// Server-side encryption key derived from JWT_SECRET (Option A)
const ENCRYPTION_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest();

function encryptServer(text: string | null | undefined): string {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptServer(encryptedText: string | null | undefined): string {
  if (!encryptedText) return '';
  try {
    const parts = encryptedText.split(':');
    if (parts.length < 2) return encryptedText; // Probably old unencrypted bookmark
    const iv = Buffer.from(parts.shift() || '', 'hex');
    const encrypted = parts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return encryptedText || '';
  }
}

app.use(cors());
app.use(express.json()); // CRITICAL: This allows us to read JSON data sent to us
app.use(express.static('public')); // This tells Express to show our index.html!

const rateLimit = require('express-rate-limit');

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
  status: { type: String, default: 'completed', enum: ['pending', 'processing', 'completed'] },
  isE2E: { type: Boolean, default: false } // Indicates if bookmark is encrypted client-side (Option B)
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

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

// 1. Verify Google Login Token & Return our own JWT
app.post('/api/auth/google', apiLimiter, async (req: express.Request, res: express.Response): Promise<any> => {
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
    // ... rest of the code remains the same ...
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// 2. Health check endpoint (you already did this!)
app.get('/api/health', (_req: express.Request, res: express.Response) => {
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
  
  // Decrypt Option A (server-side) encrypted bookmarks on-the-fly
  const processed = bookmarks.map(bm => {
    const obj = bm.toObject();
    if (!obj.isE2E) {
      obj.url = decryptServer(obj.url);
      obj.title = decryptServer(obj.title);
      obj.summary = decryptServer(obj.summary);
    }
    return obj;
  });
  
  res.json(processed);
});

// 3. ANALYZE (New): Scrape and run AI analysis without saving (essential for E2E flow)
app.post('/api/bookmarks/analyze', requireAuth, async (req: any, res: express.Response): Promise<any> => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  let analysis = {
    title: "Unknown Title",
    category: "General",
    summary: "No summary available."
  };

  let bodyText = req.body.pageText || '';

  // YouTube title fetch via oEmbed
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
  if (ytMatch) {
    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json() as any;
        analysis.title = oembedData.title || analysis.title;
      }
    } catch (e) {}
  }

  if (!bodyText) {
    try {
      const response = await fetch('https://r.jina.ai/' + url);
      bodyText = await response.text();
      bodyText = bodyText.substring(0, 3000);
    } catch (error) {
      console.log("Analysis scrape failed:", url);
    }
  }

  const user = await User.findOne({ userId: req.userId });
  const userCategories = user?.categories?.length ? user.categories : ['General'];

  try {
    const contentForAI = bodyText.length > 50
        ? `URL: ${url}\nWebpage content: ${bodyText}`
        : `URL: ${url} (Note: Could not scrape page content, please analyze based on URL only)`;

    const categoryList = JSON.stringify(userCategories);
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per window
});

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
const parsed = JSON.parse(aiText);
if (parsed.category) analysis.category = parsed.category;
if (parsed.summary) analysis.summary = parsed.summary;
if (analysis.title === "Unknown Title" && parsed.title) {
  analysis.title = parsed.title;
}
} catch (error) {
  console.log("Analysis AI failed:", error);
}

res.json(analysis);
});

app.post('/api/bookmarks', limiter, requireAuth, async (req: any, res: express.Response) => {
  const { url, title, summary, category, isE2E } = req.body;

  // Generate a unique ID
  const uniqueId = Date.now().toString();

// Delete any existing bookmark with the same URL to prevent duplicates
// Note: For E2E, we delete using the encrypted URL string sent from the client
await Bookmark.deleteMany({ userId: req.userId, url: { $eq: String(url) } });

let newBookmark: any = {
  id: uniqueId,
  userId: req.userId,
  status: 'completed',
  isE2E: !!isE2E
};
if (isE2E) {
  // Save already encrypted payloads directly
  newBookmark.url = url;
  newBookmark.title = title;
  newBookmark.summary = summary;
  newBookmark.category = category || "General";
} else {
  // Standard server-side encryption flow (Option A)
  newBookmark.url = encryptServer(url);
  newBookmark.title = "Unknown Title";
  newBookmark.category = "General";
  newBookmark.summary = encryptServer("No summary available.");

  let bodyText = req.body.pageText || '';

  // oEmbed for YouTube
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
  if (ytMatch) {
    try {
      const allowedDomains = ['https://www.youtube.com'];
      const parsedUrl = new URL(url);
      if (allowedDomains.includes(parsedUrl.origin)) {
        const oembedUrl = new URL('https://www.youtube.com/oembed');
        const params = {
          url: url,
          format: 'json'
        };
        oembedUrl.search = new URLSearchParams(params).toString();
        const response = await fetch(oembedUrl.toString());
        if (response.ok) {
          const data = await response.json();
          if (data.title) newBookmark.title = data.title;
          if (data.description) newBookmark.summary = data.description;
        }
      }
    } catch (error) {
      console.log("oEmbed failed:", error);
    }
  }
}
        oembedUrl.searchParams.set('url', encodeURIComponent(url));
        oembedUrl.searchParams.set('format', 'json');
        const oembedRes = await fetch(oembedUrl.toString());
        if (oembedRes.ok) {
          const oembedData = await oembedRes.json() as any;
          newBookmark.title = oembedData.title || newBookmark.title;
        }
      } else {
        console.log("Invalid domain:", parsedUrl.origin);
      }
    } catch (e) {
      console.log("Error fetching oembed data:", e);
    }
  }

  if (!bodyText) {
    const allowedDomains = ['https://example.com', 'https://www.example.com'];
    const parsedUrl = new URL(url);
    const targetUrl = 'https://r.jina.ai/' + url;
    const targetParsedUrl = new URL(targetUrl);
    if (allowedDomains.includes(targetParsedUrl.origin)) {
      try {
        const response = await fetch(targetUrl);
        bodyText = await response.text();
        bodyText = bodyText.substring(0, 3000);
      } catch (error) {
        console.log("Scrape failed:", url);
      }
    } else {
      console.log("Invalid domain:", targetParsedUrl.origin);
    }
  }

  const user = await User.findOne({ userId: req.userId });
  const userCategories = user?.categories?.length ? user.categories : ['General'];

  try {
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
  } catch (error) {
    console.log("Error occurred:", error);
  }
}
const aiText = completion.choices[0]?.message?.content?.trim() || "{}";
const parsed = JSON.parse(aiText);
newBookmark.category = parsed.category || newBookmark.category;
newBookmark.summary = encryptServer(parsed.summary || "No summary available.");
if (newBookmark.title === "Unknown Title" && parsed.title) {
  newBookmark.title = parsed.title;
}
} catch (error) {
  console.log("AI failed:", error);
}

newBookmark.title = encryptServer(newBookmark.title);
}
  
const dbBookmark = new Bookmark(newBookmark);
await dbBookmark.save();
  
// Decrypt if server-side encrypted before sending response
const responseBookmark = dbBookmark.toObject();
if (!responseBookmark.isE2E) {
  responseBookmark.url = decryptServer(responseBookmark.url);
  responseBookmark.title = decryptServer(responseBookmark.title);
  responseBookmark.summary = decryptServer(responseBookmark.summary);
}
  
res.json({ message: "Bookmark saved!", bookmark: responseBookmark });
});

// 5. DELETE: Remove a bookmark
const deleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.delete('/api/bookmarks/:id', requireAuth, deleteLimiter, async (req: any, res: express.Response) => {
  const idToDelete = req.params.id;
  await Bookmark.deleteOne({ id: idToDelete, userId: req.userId });
  res.json({ message: "Bookmark deleted successfully!" });
});

// Import rate limiter
const rateLimit = require('express-rate-limit');

// Create rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

// 6. UPDATE: Edit an existing bookmark (supports E2E encrypted updates)
app.put('/api/bookmarks/:id', requireAuth, limiter, async (req: any, res: express.Response): Promise<any> => {
  const idToUpdate = req.params.id;
  const { title, category } = req.body;

  const bookmark = await Bookmark.findOne({ id: idToUpdate, userId: req.userId });
  if (!bookmark) {
    return res.status(404).json({ error: "Bookmark not found" });
  }

  if (bookmark.isE2E) {
    // Payload is already encrypted by frontend
    if (title) bookmark.title = title;
  } else {
    // Server-side encryption
    if (title) bookmark.title = encryptServer(title);
  }
  }
  
  if (category) bookmark.category = category;

  await bookmark.save();

  const responseBookmark = bookmark.toObject();
  if (!responseBookmark.isE2E) {
    responseBookmark.url = decryptServer(responseBookmark.url);
    responseBookmark.title = decryptServer(responseBookmark.title);
    responseBookmark.summary = decryptServer(responseBookmark.summary);
  }

  res.json({ message: "Bookmark updated successfully!", bookmark: responseBookmark });
});
// 7. GET IMPORT STATUS
app.get('/api/bookmarks/import-status', requireAuth, async (req: any, res: express.Response) => {
  const count = await Bookmark.countDocuments({
    userId: req.userId,
    status: { $in: ['pending', 'processing'] }
  });
  res.json({ pendingCount: count });
});

// Import express-rate-limit
const rateLimit = require('express-rate-limit');

// Create a rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per window per IP
});

// 8. IMPORT: Supports background server-side encryption (Option A)
app.post('/api/bookmarks/import', requireAuth, limiter, async (req: any, res: express.Response): Promise<any> => {
  const { bookmarks } = req.body;
  if (!Array.isArray(bookmarks)) {
    return res.status(400).json({ error: "Invalid bookmarks array format" });
  }

  const userId = req.userId;
  const insertedBookmarks: any[] = [];

  for (const item of bookmarks) {
    const uniqueId = Date.now().toString() + Math.random().toString(36).substring(2, 7);
    
    // Server-side encrypt the pending bookmark immediately
    const encryptedUrl = encryptServer(item.url);
    const filter = { userId: String(userId), url: String(encryptedUrl) };
    await Bookmark.deleteMany(filter);

    const newBm = new Bookmark({
      id: uniqueId,
      userId: String(userId),
      url: encryptedUrl,
      title: encryptServer(item.title || "Untitled Link"),
      category: "General",
      summary: encryptServer("Queueing for AI analysis..."),
      status: "pending",
      isE2E: false
    });
    
    await newBm.save();
    insertedBookmarks.push(newBm);
  }

  res.json({ message: "Import started", count: insertedBookmarks.length });
  // Background worker loop
  void (async () => {
    const user = await User.findOne({ userId: String(userId) });
    const userCategories = user?.categories?.length ? user.categories : ['General'];
    const categoryList = JSON.stringify(userCategories);

    for (const bm of insertedBookmarks) {
      try {
        await Bookmark.updateOne({ id: bm.id }, { status: 'processing' });

        const decryptedUrl = decryptServer(bm.url);
        let bodyText = "";
        let finalTitle = decryptServer(bm.title) || "Untitled Link";

const ytMatch = decryptedUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
let ytTitle = "";
if (ytMatch) {
try {
const allowedDomains = ['https://www.youtube.com'];
const url = new URL(decryptedUrl);
if (allowedDomains.includes(url.origin)) {
const oembedUrl = new URL('https://www.youtube.com/oembed');
oembedUrl.searchParams.set('url', decryptedUrl);
oembedUrl.searchParams.set('format', 'json');
const oembedRes = await fetch(oembedUrl.toString());
if (oembedRes.ok) {
const oembedData = await oembedRes.json() as any;
ytTitle = oembedData.title || "";
finalTitle = ytTitle;
}
} else {
console.log("Domain not allowed:", decryptedUrl);
}
} catch (e) {
console.log("Error fetching oembed data:", e);
}
}

if (!ytTitle) {
try {
const allowedDomains = ['https://example.com', 'https://www.example.com']; 
const url = new URL(decryptedUrl);
if (allowedDomains.includes(url.origin)) {
const response = await fetch(decryptedUrl);
bodyText = await response.text();
bodyText = bodyText.substring(0, 3000);
} else {
console.log("Domain not allowed:", decryptedUrl);
}
} catch (error) {
console.log("Could not background scrape:", decryptedUrl);
}
}

const contentForAI = bodyText.length > 50
? `URL: ${decryptedUrl}\nWebpage content: ${bodyText}`
: `URL: ${decryptedUrl} (Note: Could not scrape page content, please analyze based on URL only)`;

const prompt = `You are a bookmark assistant. Analyze this webpage and return ONLY a valid JSON object (no markdown, no code blocks, no extra text).

The JSON must have exactly three keys:
title
description
tags
Your response should be in this format:
\`
{
"title": "",
"description": "",
"tags": []
}
\`
Analyze the webpage: ${contentForAI}
And provide your response in the above format.`;
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
      const parsed = JSON.parse(aiText);

      await Bookmark.updateOne({ id: bm.id }, {
          url: encryptServer(decryptedUrl),
          title: encryptServer(parsed.title || finalTitle),
          category: parsed.category || "General",
          summary: encryptServer(parsed.summary || "No summary available."),
          status: "completed"
        });

      } catch (err) {
        console.error("Background AI analysis error:", err);
        await Bookmark.updateOne({ id: bm.id }, {
          status: 'completed',
          summary: encryptServer("Failed to fetch details. Click Edit to customize.")
        });
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }
  })();
});


app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});