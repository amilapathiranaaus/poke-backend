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
const client = new vision.ImageAnnotatorClient({
  credentials: googleCredentials,
});

// Load Pokémon name list
const pokemonNames = fs.readFileSync('./pokemon_names.txt', 'utf-8')
  .split('\n')
  .map(name => name.trim().toUpperCase())
  .filter(name => name.length > 0);

// Valid evolution stages
const evolutionStages = ['BASIC', 'STAGE 1', 'STAGE 2', 'V', 'VSTAR', 'VMAX'];

// Helper: find card name
function findPokemonName(text) {
  const lines = text.split('\n').map(line => line.trim().toUpperCase());

  for (let line of lines) {
    for (let name of pokemonNames) {
      if (line.includes(name)) {
        return name;
      }
    }
  }

  return 'Unknown';
}


// Helper: find evolution stage
function findEvolutionStage(text) {
  const lines = text.split('\n').map(line => line.trim().toUpperCase());
  for (let line of lines) {
    if (evolutionStages.includes(line)) {
      return line;
    }
  }
  return 'Unknown';
}

// Helper: get card price
async function getCardPrice(cardName) {
  try {
    const response = await axios.get(
      `https://api.pokemontcg.io/v2/cards?q=name:${encodeURIComponent(cardName)}`,
      {
        headers: {
          'X-Api-Key': process.env.POKEMON_TCG_API_KEY,
        },
      }
    );
    const card = response.data?.data?.[0];
    return card?.cardmarket?.prices?.averageSellPrice || null;
  } catch (err) {
    console.error("💸 Price fetch failed:", err.message);
    return null;
  }
}

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

    // OCR
    const [result] = await client.textDetection({ image: { content: buffer } });
    const text = result.textAnnotations[0]?.description || 'No text found';
    console.log('🔍 Full OCR text:\n', text);

    const name = findPokemonName(text);
    const evolution = findEvolutionStage(text);
    const price = await getCardPrice(name);

    // ✅ Server logs
    console.log('🎴 Card Name:', name);
    console.log('🌱 Evolution Stage:', evolution);
    console.log('💰 Price:', price);

    const cardData = {
      name,
      evolution,
      price,
      fullText: text,
      imageUrl,
    };

    // Save card metadata
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
