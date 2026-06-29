import * as cheerio from 'cheerio';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json()); // CRITICAL: This allows us to read JSON data sent to us
app.use(express.static('public')); // This tells Express to show our index.html!


// 1. Our "Fake Database" (an array stored in memory)
let bookmarks: any[] = [];

// 2. Health check endpoint (you already did this!)
app.get('/api/health', (req: express.Request, res: express.Response) => {
  res.json({ status: 'success', message: 'The Bookmark API is alive!' });
});

// 3. READ: Get all saved bookmarks (GET Request)
app.get('/api/bookmarks', (req: express.Request, res: express.Response) => {
  // We simply return the array of bookmarks
  res.json(bookmarks);
});

// ... your existing code ...
// 4. CREATE: Add a new bookmark with Auto-Scraping
// 4. CREATE: Add a new bookmark
app.post('/api/bookmarks', async (req: express.Request, res: express.Response) => {
  const url = req.body.url;

  // Generate a unique ID
  const uniqueId = Date.now().toString();

  let newBookmark: any = {
    id: uniqueId, // Add the ID here!
    url: url,
    title: "Unknown Title"
  };

  try {
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);
    const pageTitle = $('title').text();
    if (pageTitle) newBookmark.title = pageTitle;
  } catch (error) {
    console.log("Could not scrape the website.");
  }

  bookmarks.push(newBookmark);
  res.json({ message: "Bookmark saved!", bookmark: newBookmark });
});

// 5. DELETE: Remove a bookmark
app.delete('/api/bookmarks/:id', (req: express.Request, res: express.Response) => {
  // Extract the ID from the URL (e.g., /api/bookmarks/12345 -> id is "12345")
  const idToDelete = req.params.id;

  // Filter the array to keep only bookmarks that DO NOT match this ID
  bookmarks = bookmarks.filter(bookmark => bookmark.id !== idToDelete);

  res.json({ message: "Bookmark deleted successfully!" });
});


app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
