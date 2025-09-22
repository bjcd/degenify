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
        // Add cache-busting parameter to force Farcaster to refresh image cache
        const cloudinaryUrl = `${image.cloudinary_url}?t=${Date.now()}`;
        
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Epic Degeneration by Degenify</title>
    <meta name="description" content="Check out this epic degeneration I created with Degenify! 🎩 🔥 $DEGEN">
    <link rel="icon" type="image/png" href="/hat-logo.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    
    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="${req.protocol}://${req.get('host')}/api/share/${imageId}">
    <meta property="og:title" content="Epic Degeneration by Degenify">
    <meta property="og:description" content="Check out this epic degeneration I created with Degenify! 🎩 🔥 $DEGEN">
    <meta property="og:image" content="${cloudinaryUrl}">
    <meta property="og:image:url" content="${cloudinaryUrl}">
    <meta property="og:image:width" content="1024">
    <meta property="og:image:height" content="1024">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:alt" content="Epic Degeneration by Degenify">
    <meta property="og:site_name" content="Degenify">
    <meta property="og:locale" content="en_US">
    
    <!-- Twitter -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:site" content="@degentokenbase">
    <meta name="twitter:creator" content="@degentokenbase">
    <meta name="twitter:url" content="${req.protocol}://${req.get('host')}/api/share/${imageId}">
    <meta name="twitter:title" content="Epic Degeneration by Degenify">
    <meta name="twitter:description" content="Check out this epic degeneration I created with Degenify! 🎩 🔥 $DEGEN">
    <meta name="twitter:image" content="${cloudinaryUrl}">
    <meta name="twitter:image:alt" content="Epic Degeneration by Degenify">
    
    <!-- Additional meta tags for better compatibility -->
    <meta name="theme-color" content="#667eea">
    <meta name="msapplication-TileColor" content="#667eea">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    
    <style>
        /* Degenify Design System - Gen Z Minimalist Aesthetic */
        :root {
            /* Base colors */
            --background: 0 0% 100%;
            --foreground: 240 10% 3.9%;
            --primary: 267 83% 58%;
            --primary-foreground: 0 0% 100%;
            --secondary: 267 30% 97%;
            --secondary-foreground: 267 83% 25%;
            --accent: 280 100% 70%;
            --accent-foreground: 0 0% 100%;
            --muted: 220 14.3% 95.9%;
            --muted-foreground: 220 8.9% 46.1%;
            --card: 0 0% 100%;
            --card-foreground: 240 10% 3.9%;
            --border: 267 20% 90%;
            --ring: 267 83% 58%;
            --radius: 1rem;
            
            /* Enhanced gradients */
            --gradient-primary: linear-gradient(135deg, hsl(267 83% 58%), hsl(280 100% 70%), hsl(290 100% 75%));
            --gradient-subtle: linear-gradient(180deg, hsl(0 0% 100%), hsl(267 15% 98%));
            --gradient-mesh: radial-gradient(circle at 20% 80%, hsl(267 83% 58% / 0.3) 0%, transparent 50%), radial-gradient(circle at 80% 20%, hsl(280 100% 70% / 0.3) 0%, transparent 50%);
            
            /* Enhanced shadows */
            --shadow-soft: 0 4px 20px hsl(267 83% 58% / 0.15);
            --shadow-glow: 0 0 40px hsl(267 83% 58% / 0.4);
            --shadow-card: 0 12px 40px hsl(240 10% 3.9% / 0.1);
            --shadow-intense: 0 20px 60px hsl(267 83% 58% / 0.25);
            
            /* Animation properties */
            --transition-smooth: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            --transition-bounce: all 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55);
        }

        * {
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background: var(--gradient-mesh);
            color: hsl(var(--foreground));
            margin: 0;
            padding: 0;
            min-height: 100vh;
            line-height: 1.6;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 1.5rem;
            text-align: center;
        }

        .header {
            padding: 1rem 0 0.5rem;
            text-align: center;
        }

        .main {
            padding: 0.5rem 0;
            text-align: center;
        }

        .footer {
            padding: 2rem 0;
            text-align: center;
            border-top: 1px solid hsl(var(--border) / 0.3);
        }

        .btn-degenify {
            background: var(--gradient-primary);
            color: hsl(var(--primary-foreground));
            font-weight: 700;
            padding: 1.5rem 3rem;
            border-radius: 1.5rem;
            box-shadow: var(--shadow-intense);
            border: none;
            cursor: pointer;
            transition: var(--transition-smooth);
            position: relative;
            overflow: hidden;
            font-size: 1.25rem;
            height: 4rem;
            width: 100%;
            max-width: 400px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
            text-decoration: none;
            margin: 2rem auto;
        }

        .btn-degenify:hover {
            box-shadow: var(--shadow-glow);
            transform: scale(1.05);
        }

        .btn-degenify:active {
            transform: scale(0.95);
        }

        .btn-degenify::before {
            content: '';
            position: absolute;
            inset: 0;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
            transform: translateX(-100%) skewX(12deg);
            transition: transform 0.7s;
        }

        .btn-degenify:hover::before {
            transform: translateX(100%);
        }

        .text-gradient {
            background: var(--gradient-primary);
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
            color: transparent;
        }

        .logo-text-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
        }

        .logo-text-container img {
            vertical-align: middle;
            transform: translateY(-2px);
        }

        .result-image {
            max-width: 100%;
            border-radius: 1rem;
            box-shadow: var(--shadow-intense);
            margin: 2rem 0;
            transition: var(--transition-smooth);
        }

        .result-image:hover {
            transform: scale(1.02);
        }

        .prompt-overlay {
            position: relative;
            margin: 2rem 0;
            display: inline-block;
            max-width: 100%;
        }

        .prompt-overlay img {
            width: 100%;
            height: auto;
            border-radius: 1rem;
            box-shadow: var(--shadow-intense);
            max-width: 600px;
        }

        .image-overlay {
            position: absolute;
            inset: 0;
            background: linear-gradient(to top, rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0.2), transparent);
            opacity: 0;
            transition: opacity 0.3s;
            border-radius: 1rem;
        }

        .prompt-overlay:hover .image-overlay {
            opacity: 1;
        }

        .overlay-content {
            position: absolute;
            bottom: 1rem;
            left: 1rem;
            right: 1rem;
        }

        .overlay-actions {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }

        .overlay-action-group {
            display: flex;
            gap: 0.5rem;
        }

        .overlay-action-btn {
            background: rgba(255, 255, 255, 0.2);
            backdrop-filter: blur(4px);
            border: 1px solid rgba(255, 255, 255, 0.3);
            color: white;
            border-radius: 0.5rem;
            padding: 0.5rem;
            cursor: pointer;
            transition: var(--transition-smooth);
            display: flex;
            align-items: center;
            justify-content: center;
            width: 2rem;
            height: 2rem;
        }

        .overlay-action-btn:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .overlay-download-btn {
            background: hsl(var(--primary) / 0.8);
            backdrop-filter: blur(4px);
            border: 1px solid hsl(var(--primary));
            color: white;
            border-radius: 0.5rem;
            padding: 0.5rem;
            cursor: pointer;
            transition: var(--transition-smooth);
            display: flex;
            align-items: center;
            justify-content: center;
            width: 2rem;
            height: 2rem;
        }

        .overlay-download-btn:hover {
            background: hsl(var(--primary));
        }

        .prompt-text {
            color: white;
            font-size: 1.125rem;
            font-weight: 500;
            line-height: 1.4;
            margin: 0;
            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
        }

        .animate-fade-in {
            animation: fadeIn 0.6s ease-out;
        }

        .animate-slide-up {
            animation: slideUp 0.8s ease-out;
        }

        @keyframes fadeIn {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        @keyframes slideUp {
            from {
                opacity: 0;
                transform: translateY(40px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
    </style>
</head>
<body>
    <div class="min-h-screen bg-gradient-mesh">
        <!-- Header -->
        <header class="header text-center">
            <div class="container text-center">
                <div class="flex flex-col items-center justify-center space-y-2 animate-fade-in">
                    <h1 class="text-3xl font-bold text-gradient logo-text-container">
                        <img src="/hat-logo.png" alt="Degenify"
                            class="drop-shadow-lg hover:scale-110 transition-transform duration-300"
                            style="width: 48px; height: 48px;" />
                        <span>Degenify</span>
                    </h1>
                </div>
            </div>
        </header>

        <!-- Main Content -->
        <main class="main text-center">
            <div class="container text-center">
                <div class="text-center mb-2 animate-slide-up">
                    <h2 class="text-2xl font-bold text-foreground mb-2 text-center">
                        Epic Degeneration
                    </h2>
                    <p class="text-muted-foreground text-center">
                        Check out this amazing creation! 🎩 🔥
                    </p>
                </div>

                <!-- Create Yours Button -->
                <a href="${req.protocol}://${req.get('host')}" class="btn-degenify group relative overflow-hidden">
                    <div class="flex items-center justify-center space-x-3 relative z-10">
                        <span class="sparkles">✨</span>
                        <span class="font-bold">Create yours now 🎩</span>
                        <span class="sparkles">✨</span>
                    </div>
                </a>

                <!-- Image with Prompt Overlay -->
                <div class="prompt-overlay">
                    <img src="${imageUrl}" alt="Epic Degeneration">
                    <div class="image-overlay">
                        <div class="overlay-content">
                            <div class="overlay-actions">
                                <div class="overlay-action-group">
                                    <button class="overlay-action-btn" onclick="shareImage('${imageId}')">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 1 1 0-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 1 1 5.367-2.684 3 3 0 0 1-5.367 2.684zm0 9.316a3 3 0 1 1 5.367 2.684 3 3 0 0 1-5.367-2.684z"/>
                                        </svg>
                                    </button>
                                </div>
                                <button class="overlay-download-btn" onclick="downloadImage('${imageId}')">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                        <polyline points="7,10 12,15 17,10"/>
                                        <line x1="12" y1="15" x2="12" y2="3"/>
                                    </svg>
                                </button>
                            </div>
                            <p class="prompt-text">${image.prompt}</p>
                        </div>
                    </div>
                </div>
            </div>
        </main>

        <!-- Footer -->
        <footer class="footer">
            <div class="container">
                <p class="text-sm text-muted-foreground">
                    Made with 💜 for the degen community
                </p>
            </div>
        </footer>
    </div>

    <script>
        // Share image function
        function shareImage(imageId) {
            const shareUrl = window.location.origin + '/api/share/' + imageId;
            const text = 'Check out this epic degeneration I created with Degenify! 🎩 🔥 \\nCreate yours on ' + window.location.origin + '\\n\\n$DEGEN @degentokenbase';
            const twitterUrl = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(shareUrl);
            window.open(twitterUrl, '_blank');
        }

        // Download image function
        function downloadImage(imageId) {
            fetch('/api/download/' + imageId)
                .then(response => {
                    if (!response.ok) {
                        throw new Error('Download failed');
                    }
                    return response.blob();
                })
                .then(blob => {
                    const url = window.URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = 'meme-' + imageId + '.png';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    window.URL.revokeObjectURL(url);
                })
                .catch(error => {
                    console.error('Download error:', error);
                    alert('Download failed: ' + error.message);
                });
        }
    </script>
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
