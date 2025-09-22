import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetch } from 'undici';
import { Pool } from 'pg';
import { v2 as cloudinary } from 'cloudinary';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
let MODEL_ID = process.env.MODEL_ID || 'gemini-2.5-flash-image-preview';
if (MODEL_ID === 'gemini-2.5-flash-image') {
    MODEL_ID = 'gemini-2.5-flash-image-preview';
}
const BASE_IMAGE_PATH = process.env.BASE_IMAGE_PATH || 'public/base.png';
const GOOGLE_API_BASE = process.env.GOOGLE_API_BASE || 'https://generativelanguage.googleapis.com';

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database table
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS images (
                id VARCHAR(255) PRIMARY KEY,
                prompt TEXT NOT NULL,
                cloudinary_url TEXT NOT NULL,
                cloudinary_public_id VARCHAR(255) NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('Database initialized successfully');
    } catch (err) {
        console.error('Database initialization failed:', err);
    }
}

// Initialize database on startup
initDatabase();

app.post('/api/generate', async (req, res) => {
    try {
        const { prompt } = req.body || {};
        if (!prompt) return res.status(400).json({ error: 'prompt required' });

        const basePath = path.join(__dirname, BASE_IMAGE_PATH);
        if (!fs.existsSync(basePath)) return res.status(400).json({ error: 'Base image missing at ' + BASE_IMAGE_PATH });
        const baseImage = fs.readFileSync(basePath);

        if (!GOOGLE_API_KEY) {
            res.setHeader('Content-Type', 'image/png');
            return res.status(200).send(baseImage);
        }

        const url = `${GOOGLE_API_BASE}/v1beta/models/${MODEL_ID}:generateContent`;

        // Enhanced prompt to ensure purple hat preservation
        const enhancedPrompt = `You are an image editor. You must ALWAYS preserve the purple hat from the base image character. 
        
Instructions:
1. Keep the distinctive PURPLE HAT from the base image character
2. The character can change poses, expressions, and clothing to fit the situation
3. The character can be dressed differently for the new context
4. Only modify the background, setting, or environment around the character
5. Place the character in the new situation described: ${prompt}
6. The purple hat must remain visible and distinctive

Situation to create: ${prompt}`;

        const requestBody = {
            contents: [
                {
                    parts: [
                        { text: enhancedPrompt },
                        {
                            inlineData: {
                                mimeType: 'image/png',
                                data: baseImage.toString('base64'),
                            },
                        },
                    ],
                },
            ],
        };

        const aiRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GOOGLE_API_KEY },
            body: JSON.stringify(requestBody),
        });

        if (!aiRes.ok) {
            const errText = await aiRes.text();
            return res.status(502).json({ error: 'Google API error', detail: errText });
        }

        const data = await aiRes.json();
        let b64;
        try {
            const parts = data.candidates?.[0]?.content?.parts || [];
            for (const p of parts) {
                if (p.inline_data?.data) { b64 = p.inline_data.data; break; }
                if (p.inlineData?.data) { b64 = p.inlineData.data; break; }
            }
        } catch { }

        if (!b64) {
            return res.status(502).json({ error: 'No image returned', detail: data });
        }

        const imgBuffer = Buffer.from(b64, 'base64');

        // Upload to Cloudinary
        const imageId = Date.now() + Math.random();
        const cloudinaryResult = await cloudinary.uploader.upload(
            `data:image/png;base64,${b64}`,
            {
                public_id: `degenify/${imageId}`,
                folder: 'degenify',
                resource_type: 'image'
            }
        );

        // Store metadata in PostgreSQL
        await pool.query(
            'INSERT INTO images (id, prompt, cloudinary_url, cloudinary_public_id) VALUES ($1, $2, $3, $4)',
            [imageId, prompt, cloudinaryResult.secure_url, cloudinaryResult.public_id]
        );

        res.setHeader('Content-Type', 'image/png');
        return res.status(200).send(imgBuffer);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'server error' });
    }
});

// API endpoint to get all generated images (sorted by newest first)
app.get('/api/gallery', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM images ORDER BY timestamp DESC');
        const images = result.rows.map(row => ({
            id: row.id,
            prompt: row.prompt,
            imageData: row.cloudinary_url, // Frontend will use this as image src
            timestamp: row.timestamp
        }));
        res.json(images);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// API endpoint to serve image directly (for social media previews)
app.get('/api/image/:id', async (req, res) => {
    try {
        const imageId = req.params.id;
        const result = await pool.query('SELECT * FROM images WHERE id = $1', [imageId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Image not found' });
        }

        const image = result.rows[0];

        // Fetch image from Cloudinary and serve directly
        const response = await fetch(image.cloudinary_url);
        if (!response.ok) {
            return res.status(404).json({ error: 'Image not found on Cloudinary' });
        }

        const imageBuffer = await response.arrayBuffer();
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
        res.send(Buffer.from(imageBuffer));
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// API endpoint to serve image with Open Graph meta tags (for social media previews)
app.get('/api/share/:id', async (req, res) => {
    try {
        const imageId = req.params.id;
        const result = await pool.query('SELECT * FROM images WHERE id = $1', [imageId]);

        if (result.rows.length === 0) {
            return res.status(404).send('Image not found');
        }

        const image = result.rows[0];
        const imageUrl = `${req.protocol}://${req.get('host')}/api/image/${imageId}`;
        
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Epic Degeneration by Degenify</title>
    <meta name="description" content="Check out this epic degeneration I created with Degenify! 🎩 🔥 $DEGEN">
    
    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="${req.protocol}://${req.get('host')}/api/share/${imageId}">
    <meta property="og:title" content="Epic Degeneration by Degenify">
    <meta property="og:description" content="Check out this epic degeneration I created with Degenify! 🎩 🔥 $DEGEN">
    <meta property="og:image" content="${imageUrl}">
    <meta property="og:image:width" content="1024">
    <meta property="og:image:height" content="1024">
    <meta property="og:image:type" content="image/png">
    
    <!-- Twitter -->
    <meta property="twitter:card" content="summary_large_image">
    <meta property="twitter:url" content="${req.protocol}://${req.get('host')}/api/share/${imageId}">
    <meta property="twitter:title" content="Epic Degeneration by Degenify">
    <meta property="twitter:description" content="Check out this epic degeneration I created with Degenify! 🎩 🔥 $DEGEN">
    <meta property="twitter:image" content="${imageUrl}">
    
    <style>
        body { 
            margin: 0; 
            padding: 20px; 
            font-family: Arial, sans-serif; 
            text-align: center;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        img { 
            max-width: 100%; 
            height: auto; 
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        h1 { margin-bottom: 20px; }
        .prompt { 
            background: rgba(255,255,255,0.1); 
            padding: 15px; 
            border-radius: 10px; 
            margin: 20px 0;
            backdrop-filter: blur(10px);
        }
    </style>
</head>
<body>
    <h1>🎩 Epic Degeneration by Degenify</h1>
    <div class="prompt">
        <strong>Prompt:</strong> ${image.prompt}
    </div>
    <img src="${imageUrl}" alt="Epic Degeneration">
    <p>Created with Degenify - Transform any situation! 🔥</p>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).send('Server error');
    }
});

// API endpoint to download a specific image
app.get('/api/download/:id', async (req, res) => {
    try {
        const imageId = req.params.id;
        const result = await pool.query('SELECT * FROM images WHERE id = $1', [imageId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Image not found' });
        }

        const image = result.rows[0];

        // Redirect to Cloudinary URL for download
        res.redirect(image.cloudinary_url);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.listen(PORT, () => console.log('Server on http://localhost:' + PORT));
