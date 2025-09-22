# Degenify - AI Meme Generator

An AI-powered meme generator using Google's Gemini 2.5 Flash Image model. Generate hilarious memes by describing any situation!

## Features

- 🎩 **AI Image Generation** - Powered by Google Gemini 2.5 Flash Image
- 🖼️ **Persistent Gallery** - Images stored in Cloudinary + PostgreSQL
- 📱 **Mobile Friendly** - Responsive design with touch-optimized buttons
- 🔗 **Social Sharing** - Share to X (Twitter) and Farcaster
- 💾 **Download Images** - High-resolution downloads
- ⚡ **Real-time Generation** - Fast AI processing

## Tech Stack

- **Frontend**: HTML, CSS, JavaScript
- **Backend**: Node.js, Express
- **AI**: Google Gemini 2.5 Flash Image API
- **Storage**: Cloudinary (images) + PostgreSQL (metadata)
- **Deployment**: Railway

## Setup Instructions

### 1. Environment Variables

Create a `.env` file with:

```env
# Google AI
GOOGLE_API_KEY=your_google_api_key
MODEL_ID=gemini-2.5-flash-image-preview
BASE_IMAGE_PATH=./public/base.png

# Cloudinary (for image storage)
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Database (Railway PostgreSQL)
DATABASE_URL=your_postgresql_connection_string

# Server
PORT=3000
```

### 2. Cloudinary Setup

1. Go to [Cloudinary.com](https://cloudinary.com)
2. Sign up for free account
3. Get your cloud name, API key, and API secret
4. Add them to your `.env` file

### 3. Railway Setup

1. Go to [Railway.app](https://railway.app)
2. Connect your GitHub repository
3. Add PostgreSQL service
4. Add environment variables in Railway dashboard
5. Deploy!

### 4. Local Development

```bash
npm install
npm start
```

## API Endpoints

- `POST /api/generate` - Generate new meme
- `GET /api/gallery` - Get all generated images
- `GET /api/download/:id` - Download specific image

## How It Works

1. User enters a prompt describing a situation
2. Google Gemini AI generates an image based on the prompt + base image
3. Image is uploaded to Cloudinary for permanent storage
4. Metadata is stored in PostgreSQL database
5. Image appears in the gallery for all users to see

## Cost Breakdown

- **Cloudinary**: FREE (25GB storage, 25GB bandwidth)
- **Railway PostgreSQL**: $5/month (1GB storage)
- **Google AI API**: Pay per use (~$0.01 per image)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - feel free to use this project!
# Force redeploy Mon Sep 22 12:38:32 CEST 2025
# Force Railway redeploy Mon Sep 22 13:10:10 CEST 2025
# Force GitHub deployment Mon Sep 22 13:47:36 CEST 2025
# Force deploy again Mon Sep 22 14:13:53 CEST 2025
