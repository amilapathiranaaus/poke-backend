const express = require('express');
const cors = require('cors');
const AWS = require('aws-sdk');
const vision = require('@google-cloud/vision');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// AWS S3 setup
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const s3 = new AWS.S3();
const BUCKET = process.env.S3_BUCKET_NAME;

// Google Vision setup
const googleCredentials = require('./gcloud-key.json');
const client = new vision.ImageAnnotatorClient({ credentials: googleCredentials });

// Load Pokémon name list
const pokemonNames = fs.readFileSync('pokemon-names.txt', 'utf-8')
  .split('\n')
  .map(name => name.trim().toLowerCase());

// Evolution stages
const stages = ['BASIC', 'STAGE 1', 'STAGE 2', 'V', 'VSTAR', 'VMAX'];

// POST /process-card
app.post('/process-card', async (req, res) => {
  try {
    const base64 = req.body.imageBase64.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');
    const id = `pokemon-${Date.now()}`;
    const imageKey = `${id}.jpg`;
    const metadataKey = `${id}.json`;

    // Upload image to S3
    await s3.putObject({
      Bucket: BUCKET,
      Key: imageKey,
      Body: buffer,
      ContentType: 'image/jpeg',
    }).promise();

    const imageUrl = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${imageKey}`;

    // OCR with Google Vision
    const [result] = await client.textDetection({ image: { content: buffer } });
    const text = result.textAnnotations[0]?.description || 'No text found';
    console.log('🔍 OCR text:\n', text);

    const lines = text.split('\n').map(line => line.trim());

    // Extract Pokémon name
    let cardName = 'Unknown';
    for (const line of lines) {
      const clean = line.toLowerCase();
      if (pokemonNames.includes(clean)) {
        cardName = line;
        break;
      }
    }

    // Extract evolution stage
    let evolutionStage = 'Unknown';
    for (const line of lines) {
      const upper = line.toUpperCase();
      if (stages.includes(upper)) {
        evolutionStage = upper;
        break;
      }
    }

    console.log('📛 Name:', cardName);
    console.log('🔁 Stage:', evolutionStage);

    // Query Pokémon TCG API
    let price = null;
    if (cardName !== 'Unknown') {
      const response = await axios.get(
        `https://api.pokemontcg.io/v2/cards?q=name:${encodeURIComponent(cardName)}`,
        {
          headers: {
            'X-Api-Key': process.env.POKEMON_TCG_API_KEY
          }
        }
      );

      const card = response.data?.data?.[0];
      if (card?.cardmarket?.prices?.averageSellPrice) {
        price = card.cardmarket.prices.averageSellPrice;
      }
    }

    const cardData = {
      name: cardName,
      evolutionStage,
      price,
      fullText: text,
      imageUrl,
    };

    // Save metadata
    await s3.putObject({
      Bucket: BUCKET,
      Key: metadataKey,
      Body: JSON.stringify(cardData),
      ContentType: 'application/json',
    }).promise();

    res.json(cardData);
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: 'Processing failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
