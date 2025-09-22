import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetch } from 'undici';

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

// In-memory storage for generated images
let generatedImages = [];

// Load existing images from file on startup
const GALLERY_FILE = 'gallery.json';
try {
    if (fs.existsSync(GALLERY_FILE)) {
        const data = fs.readFileSync(GALLERY_FILE, 'utf8');
        generatedImages = JSON.parse(data);
        console.log(`Loaded ${generatedImages.length} images from gallery`);
    }
} catch (err) {
    console.error('Failed to load gallery:', err);
    generatedImages = [];
}

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

        // Store the generated image in memory and file
        const imageData = {
            id: Date.now() + Math.random(),
            prompt: prompt,
            imageData: imgBuffer.toString('base64'),
            timestamp: new Date().toISOString()
        };
        generatedImages.push(imageData);

        // Save to file
        try {
            fs.writeFileSync(GALLERY_FILE, JSON.stringify(generatedImages, null, 2));
        } catch (err) {
            console.error('Failed to save gallery:', err);
        }

        res.setHeader('Content-Type', 'image/png');
        return res.status(200).send(imgBuffer);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'server error' });
    }
});

// API endpoint to get all generated images (sorted by newest first)
app.get('/api/gallery', (req, res) => {
    const sortedImages = [...generatedImages].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(sortedImages);
});

// API endpoint to serve image directly (for social media previews)
app.get('/api/image/:id', (req, res) => {
    const imageId = req.params.id;
    const image = generatedImages.find(img => img.id == imageId);

    if (!image) {
        return res.status(404).json({ error: 'Image not found' });
    }

    const imageBuffer = Buffer.from(image.imageData, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.send(imageBuffer);
});

// API endpoint to download a specific image
app.get('/api/download/:id', (req, res) => {
    const imageId = req.params.id;
    const image = generatedImages.find(img => img.id == imageId);

    if (!image) {
        return res.status(404).json({ error: 'Image not found' });
    }

    const imageBuffer = Buffer.from(image.imageData, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="meme-${imageId}.png"`);
    res.send(imageBuffer);
});

app.listen(PORT, () => console.log('Server on http://localhost:' + PORT));


